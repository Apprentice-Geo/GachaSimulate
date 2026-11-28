use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};

use gachasimulate_config_store::{
    ConfigDownloader, ConfigStore, ConfigStoreOptions, OFFICIAL_CONFIG_INDEX_URL,
};
use gachasimulate_desktop_contract::{
    CancelSimulationRequest, ConfigSource, ConfirmResultSessionRequest, DesktopError,
    DesktopErrorCode, SimulationCommandRequest, SimulationStatus, SimulationTaskEvent,
    SimulationTaskSnapshot,
};
use gachasimulate_host::{DesktopHost, HostConfig};
use sha2::{Digest, Sha256};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

struct LocalDistDownloader {
    dist_root: PathBuf,
}

impl ConfigDownloader for LocalDistDownloader {
    fn download(&self, url: &str, limit: usize) -> Result<Vec<u8>, DesktopError> {
        let base_dir = OFFICIAL_CONFIG_INDEX_URL
            .rsplit_once('/')
            .map(|(prefix, _)| prefix)
            .unwrap();
        let rel = url
            .strip_prefix(base_dir)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or_else(|| {
                DesktopError::new(
                    DesktopErrorCode::Repository,
                    format!("unexpected test URL: {url}"),
                )
            })?;
        let path = self.dist_root.join(rel.replace('/', "\\"));
        let bytes = fs::read(&path).map_err(|error| {
            DesktopError::new(
                DesktopErrorCode::Repository,
                format!("failed to read {}: {error}", path.display()),
            )
        })?;
        if bytes.len() > limit {
            return Err(DesktopError::new(
                DesktopErrorCode::Repository,
                format!("download exceeds {limit} bytes"),
            ));
        }
        Ok(bytes)
    }
}

fn worker_binary() -> PathBuf {
    if let Ok(explicit) = std::env::var("GACHASIMULATE_INSTALLED_WORKER") {
        let path = PathBuf::from(explicit);
        assert!(
            path.is_file(),
            "GACHASIMULATE_INSTALLED_WORKER does not exist: {}",
            path.display()
        );
        return path;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for candidate in [
        root.join("src-tauri/bin/gachasimulate-worker-x86_64-pc-windows-msvc.exe"),
        root.join("target/release/gachasimulate-worker.exe"),
        root.join("target/debug/gachasimulate-worker.exe"),
    ] {
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!("gachasimulate-worker binary not found; run scripts/stage_tauri_worker.ps1 first");
}

fn wait_for_status(
    rx: &mpsc::Receiver<SimulationTaskEvent>,
    predicate: impl Fn(&SimulationTaskSnapshot) -> bool,
    timeout: Duration,
) -> SimulationTaskSnapshot {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "timed out waiting for expected simulation status"
        );
        let event = rx
            .recv_timeout(remaining)
            .expect("simulation event channel closed or timed out");
        if predicate(&event.snapshot) {
            return event.snapshot;
        }
    }
}

fn make_deterministic_config(dir: &Path, id: &str, score_a: u32, score_b: u32) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("manifest.yaml"),
        format!(
            "id: {id}\nname: Local {id}\ndescription: Deterministic local override\nterminations:\n  - file: term.yaml\n    name: 固定步数\n  - file: slow.yaml\n    name: 长任务取消测试\n"
        ),
    )
    .unwrap();
    fs::write(
        dir.join("config.yaml"),
        format!(
            "schema_version: 2\nitems:\n  - item_a: 物品A\n  - item_b: 物品B\npools:\n  - main:\n      - probability: 1\n        actions:\n          - item_a += {score_a}\n          - item_b += {score_b}\ninitial:\n  - item_a = 0\n  - item_b = 0\nevery_draw: []\n"
        ),
    )
    .unwrap();
    fs::write(
        dir.join("term.yaml"),
        format!(
            "retained_items: []\ntermination_rule:\n  condition:\n    check: item_a >= {score_a}\n    actions: terminate done\n"
        ),
    )
    .unwrap();
    fs::write(
        dir.join("slow.yaml"),
        format!(
            "retained_items: []\ntermination_rule:\n  condition:\n    check: item_a >= {}\n    actions: terminate done\n",
            score_a * 200
        ),
    )
    .unwrap();
}

fn build_synthetic_official_dist(dist_root: &Path, id: &str) {
    let packages_dir = dist_root.join("packages");
    fs::create_dir_all(&packages_dir).unwrap();

    let manifest = format!(
        "id: {id}\nname: Official {id}\ndescription: Synthetic official package\nterminations:\n  - file: term.yaml\n    name: 官方固定步数\n"
    );
    let config = "schema_version: 2\nitems:\n  - item_a: 官方物品A\npools:\n  - main:\n      - probability: 1\n        actions: item_a += 111\ninitial: item_a = 0\nevery_draw: []\n";
    let term = "retained_items: []\ntermination_rule:\n  condition:\n    check: item_a >= 111\n    actions: terminate done\n";

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in [
            ("manifest.yaml", manifest.as_str()),
            ("config.yaml", config),
            ("term.yaml", term),
        ] {
            writer.start_file(name, opts).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }
    let zip_bytes = cursor.into_inner();
    let sha256: String = Sha256::digest(&zip_bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let zip_rel = format!("packages/{id}.zip");
    fs::write(packages_dir.join(format!("{id}.zip")), &zip_bytes).unwrap();

    let index = serde_json::json!({
        "format_version": 1,
        "configs": [
            {
                "id": id,
                "name": format!("Official {id}"),
                "description": "Synthetic official package",
                "download_url": zip_rel,
                "sha256": sha256
            }
        ]
    });
    fs::write(
        dist_root.join("index.json"),
        serde_json::to_vec_pretty(&index).unwrap(),
    )
    .unwrap();
}

#[test]
fn milestone2_fresh_install_e2e_covers_same_id_switch_item_cancel_restart_and_large_total() {
    let temp = std::env::temp_dir().join(format!(
        "gachasimulate-m2-e2e-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let data_root = temp.join("data");
    let local_root = temp.join("local-configs");
    let worker = worker_binary();
    fs::create_dir_all(&data_root).unwrap();
    fs::create_dir_all(&local_root).unwrap();

    // Use real 1E dist when GACHASIMULATE_CONFIGS_DIST is supplied; otherwise
    // synthesize a deterministic official dist so CI runs self-contained.
    let dist_root = if let Ok(explicit) = std::env::var("GACHASIMULATE_CONFIGS_DIST") {
        let path = PathBuf::from(explicit);
        assert!(
            path.join("index.json").is_file(),
            "GACHASIMULATE_CONFIGS_DIST missing index.json: {}",
            path.display()
        );
        path
    } else {
        let synthetic_dist = temp.join("official-dist");
        build_synthetic_official_dist(&synthetic_dist, "demo-official");
        synthetic_dist
    };

    let (tx, rx) = mpsc::channel();
    let store_options = ConfigStoreOptions {
        downloader: Arc::new(LocalDistDownloader {
            dist_root: dist_root.clone(),
        }),
        ..ConfigStoreOptions::default()
    };
    let store =
        Arc::new(ConfigStore::with_options(data_root.join("configs"), store_options).unwrap());
    let host = DesktopHost::new(
        HostConfig::new(
            data_root.join("results"),
            worker.clone(),
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        ),
        store.clone(),
    )
    .unwrap();

    // 1. Refresh official index & install an official config from 1E dist.
    let repo_state = store.refresh_config_repository(Some(true)).unwrap();
    assert!(
        !repo_state.official.is_empty(),
        "official index must list packages"
    );
    let official_id = repo_state.official[0].id.clone();
    store.install_config(&official_id).unwrap();

    // 2. Place a distinguishable local config with the EXACT SAME ID.
    make_deterministic_config(&local_root.join(&official_id), &official_id, 777, 333);
    store.set_local_config_directory(&local_root).unwrap();

    let all_configs = store.list_configs().unwrap();
    let installed_cfg = all_configs
        .iter()
        .find(|c| c.source == ConfigSource::Installed && c.id == official_id)
        .expect("installed config must be listed");
    let local_cfg = all_configs
        .iter()
        .find(|c| c.source == ConfigSource::Local && c.id == official_id)
        .expect("same-ID local config must coexist independently");

    // 3a. Run official installed config.
    let official_term = installed_cfg.terminations[0].file.clone();
    let official_item = installed_cfg.items[0].id.clone();
    let official_start = host
        .simulation
        .start_simulation(SimulationCommandRequest {
            config_source: ConfigSource::Installed,
            config_id: official_id.clone(),
            termination: official_term,
            result_item: official_item.clone(),
            total_runs: 20,
            seed: 42,
            threads: 2,
        })
        .unwrap();
    let official_done = wait_for_status(
        &rx,
        |s| s.task_id == official_start.task_id && s.status == SimulationStatus::Completed,
        Duration::from_secs(30),
    );
    let official_candidate = host.results.open_simulation_result().unwrap();
    assert_eq!(official_candidate.analysis.result_item.id, official_item);
    assert_eq!(
        official_candidate.analysis.totals.result,
        official_done.total_result.clone().unwrap()
    );
    let confirmed = host
        .results
        .confirm_result_session(ConfirmResultSessionRequest {
            session_id: official_candidate.session_id.clone(),
        })
        .unwrap();
    assert!(confirmed.confirmed);

    // 3b. Run same-ID local config with item_a (always 777 per run -> 15540 over 20 runs).
    let local_a_start = host
        .simulation
        .start_simulation(SimulationCommandRequest {
            config_source: ConfigSource::Local,
            config_id: official_id.clone(),
            termination: local_cfg.terminations[0].file.clone(),
            result_item: "item_a".into(),
            total_runs: 20,
            seed: 42,
            threads: 2,
        })
        .unwrap();
    let local_a_done = wait_for_status(
        &rx,
        |s| s.task_id == local_a_start.task_id && s.status == SimulationStatus::Completed,
        Duration::from_secs(30),
    );
    assert_eq!(local_a_done.total_result.as_deref(), Some("15540"));
    let local_a_candidate = host.results.open_simulation_result().unwrap();
    assert_eq!(local_a_candidate.analysis.result_item.id, "item_a");
    assert_eq!(local_a_candidate.analysis.totals.result, "15540");

    // 4. Switch result_item on the same local config to item_b (always 333 -> 6660 over 20 runs).
    let local_b_start = host
        .simulation
        .start_simulation(SimulationCommandRequest {
            config_source: ConfigSource::Local,
            config_id: official_id.clone(),
            termination: local_cfg.terminations[0].file.clone(),
            result_item: "item_b".into(),
            total_runs: 20,
            seed: 42,
            threads: 2,
        })
        .unwrap();
    let local_b_done = wait_for_status(
        &rx,
        |s| s.task_id == local_b_start.task_id && s.status == SimulationStatus::Completed,
        Duration::from_secs(30),
    );
    assert_eq!(local_b_done.total_result.as_deref(), Some("6660"));
    let local_b_path = host.simulation.last_completed_result_path().unwrap();
    let local_b_candidate = host.results.open_simulation_result().unwrap();
    assert_eq!(local_b_candidate.analysis.result_item.id, "item_b");
    assert_eq!(local_b_candidate.analysis.result_item.name, "物品B");
    assert_eq!(local_b_candidate.analysis.totals.result, "6660");
    assert_eq!(local_b_candidate.analysis.statistic.p50, "333");

    // 5. Cancel a large simulation mid-run -> no new GSR committed, temp cleaned up.
    let files_before_cancel: Vec<_> = fs::read_dir(host.results_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    let cancel_start = host
        .simulation
        .start_simulation(SimulationCommandRequest {
            config_source: ConfigSource::Local,
            config_id: official_id.clone(),
            termination: "slow.yaml".into(),
            result_item: "item_a".into(),
            total_runs: 50_000_000,
            seed: 99,
            threads: 2,
        })
        .unwrap();
    let cancel_id = cancel_start.task_id.unwrap();
    wait_for_status(
        &rx,
        |s| {
            s.task_id == Some(cancel_id)
                && matches!(
                    s.status,
                    SimulationStatus::Running | SimulationStatus::Saving
                )
        },
        Duration::from_secs(15),
    );
    let cancel_ack = host
        .simulation
        .cancel_simulation(CancelSimulationRequest { task_id: cancel_id })
        .unwrap();
    assert_eq!(cancel_ack.status, SimulationStatus::Cancelling);
    wait_for_status(
        &rx,
        |s| s.task_id == Some(cancel_id) && s.status == SimulationStatus::Cancelled,
        Duration::from_secs(15),
    );
    let files_after_cancel: Vec<_> = fs::read_dir(host.results_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        files_before_cancel.len(),
        files_after_cancel.len(),
        "cancelled simulation must not leave temp files or commit new GSR"
    );

    // Clean shutdown and simulate full app restart on the same data_root.
    host.shutdown().unwrap();
    drop(host);
    drop(store);

    // 6. Restart: verify persisted configs, reopen committed local_b result,
    // and open 1D's large-total-9007199254740993.gsr verifying exact integer reading.
    let (tx2, _rx2) = mpsc::channel();
    let restarted_store = Arc::new(ConfigStore::new(data_root.join("configs")).unwrap());
    let restarted_configs = restarted_store.list_configs().unwrap();
    assert!(restarted_configs
        .iter()
        .any(|c| c.source == ConfigSource::Installed && c.id == official_id));
    assert!(restarted_configs
        .iter()
        .any(|c| c.source == ConfigSource::Local && c.id == official_id));

    let restarted_host = DesktopHost::new(
        HostConfig::new(
            data_root.join("results"),
            worker,
            Arc::new(move |event| {
                let _ = tx2.send(event);
            }),
        ),
        restarted_store,
    )
    .unwrap();
    let reopened = restarted_host
        .results
        .select_gsr_result(Some(&local_b_path))
        .unwrap()
        .unwrap();
    assert_eq!(reopened.analysis.result_item.id, "item_b");
    assert_eq!(reopened.analysis.totals.result, "6660");
    assert!(
        restarted_host
            .results
            .confirm_result_session(ConfirmResultSessionRequest {
                session_id: reopened.session_id,
            })
            .unwrap()
            .confirmed
    );

    let large_gsr = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("crates/gachasimulate-gsr/fixtures/large-total-9007199254740993.gsr");
    let large_candidate = restarted_host
        .results
        .select_gsr_result(Some(&large_gsr))
        .unwrap()
        .unwrap();
    assert_eq!(large_candidate.analysis.totals.result, "9007199254740993");
    assert!(
        restarted_host
            .results
            .confirm_result_session(ConfirmResultSessionRequest {
                session_id: large_candidate.session_id,
            })
            .unwrap()
            .confirmed
    );

    restarted_host.shutdown().unwrap();
    let _ = fs::remove_dir_all(&temp);
}

#[test]
#[ignore = "requires live HTTPS access to official GitHub config repository"]
fn milestone2_live_official_https_download_and_simulation_smoke() {
    let temp = std::env::temp_dir().join(format!(
        "gachasimulate-m2-live-https-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let data_root = temp.join("data");
    let worker = worker_binary();
    fs::create_dir_all(&data_root).unwrap();

    let (tx, rx) = mpsc::channel();
    let store = Arc::new(ConfigStore::new(data_root.join("configs")).unwrap());
    let host = DesktopHost::new(
        HostConfig::new(
            data_root.join("results"),
            worker,
            Arc::new(move |event| {
                let _ = tx.send(event);
            }),
        ),
        store.clone(),
    )
    .unwrap();

    let repo_state = store.refresh_config_repository(Some(true)).unwrap();
    assert!(
        !repo_state.official.is_empty(),
        "live official index returned no configs"
    );
    let official_id = repo_state.official[0].id.clone();
    store.install_config(&official_id).unwrap();

    let configs = store.list_configs().unwrap();
    let installed = configs
        .iter()
        .find(|c| c.source == ConfigSource::Installed && c.id == official_id)
        .expect("downloaded official config must be listed");
    let started = host
        .simulation
        .start_simulation(SimulationCommandRequest {
            config_source: ConfigSource::Installed,
            config_id: official_id,
            termination: installed.terminations[0].file.clone(),
            result_item: installed.items[0].id.clone(),
            total_runs: 10,
            seed: 7,
            threads: 2,
        })
        .unwrap();
    wait_for_status(
        &rx,
        |s| s.task_id == started.task_id && s.status == SimulationStatus::Completed,
        Duration::from_secs(30),
    );
    let candidate = host.results.open_simulation_result().unwrap();
    assert_eq!(candidate.analysis.totals.runs, "10");

    host.shutdown().unwrap();
    let _ = fs::remove_dir_all(&temp);
}
