use std::{
    fs,
    io::{self, BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use gachasimulate_desktop_contract::{
    CancelSimulationRequest, ConfigSnapshotProvider, ConfigSource, ConfirmResultSessionRequest,
    DesktopError, DesktopErrorCode, DiscardResultDraftRequest, DisplayConfig,
    ResolvedConfigSnapshot, ResultCandidateSession, SaveResultFieldsRequest,
    SimulationCommandRequest, SimulationStatus, SimulationTaskEvent, SimulationTaskSnapshot,
    WorkerSimulationEvent, WorkerSimulationJob, WorkerSimulationOptions,
};
use gachasimulate_host::{DesktopHost, HostConfig, WorkerKiller};
use gachasimulate_types::fixtures::config_package;
use tempfile::{tempdir, TempDir};

const WORKER: &str = env!("CARGO_BIN_EXE_gachasimulate-worker");
const KNOWN: &[u8] = include_bytes!("../../gachasimulate-gsr/fixtures/known-results.gsr");
const LARGE: &[u8] =
    include_bytes!("../../gachasimulate-gsr/fixtures/large-total-9007199254740993.gsr");
const WAIT: Duration = Duration::from_secs(15);

struct FixtureProvider;
impl ConfigSnapshotProvider for FixtureProvider {
    fn resolve_snapshot(
        &self,
        source: ConfigSource,
        id: &str,
    ) -> Result<ResolvedConfigSnapshot, DesktopError> {
        Ok(ResolvedConfigSnapshot {
            source,
            config_id: id.into(),
            snapshot: config_package().snapshot,
        })
    }
}

fn request(runs: u64) -> SimulationCommandRequest {
    SimulationCommandRequest {
        config_source: ConfigSource::Local,
        config_id: "example".into(),
        termination: "termination.yaml".into(),
        result_item: "score".into(),
        total_runs: runs,
        seed: -5,
        threads: 1,
    }
}

fn host_config(
    root: &Path,
    worker: impl Into<PathBuf>,
) -> (HostConfig, Receiver<SimulationTaskEvent>) {
    let (sender, events) = mpsc::channel();
    let config = HostConfig::new(
        root.join("results"),
        worker,
        Arc::new(move |event| {
            let _ = sender.send(event);
        }),
    );
    (config, events)
}

fn host(root: &Path) -> (DesktopHost, Receiver<SimulationTaskEvent>) {
    let (config, events) = host_config(root, WORKER);
    (
        DesktopHost::new(config, Arc::new(FixtureProvider)).unwrap(),
        events,
    )
}

fn wait_for(mut condition: impl FnMut() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < WAIT);
        thread::sleep(Duration::from_millis(10));
    }
}

fn events_until(
    events: &Receiver<SimulationTaskEvent>,
    mut predicate: impl FnMut(&SimulationTaskSnapshot) -> bool,
) -> Vec<SimulationTaskEvent> {
    let end = Instant::now() + WAIT;
    let mut seen = Vec::new();
    loop {
        let event = events
            .recv_timeout(end.saturating_duration_since(Instant::now()))
            .expect("simulation event");
        let matched = predicate(&event.snapshot);
        seen.push(event);
        if matched {
            return seen;
        }
    }
}

fn status(
    events: &Receiver<SimulationTaskEvent>,
    status: SimulationStatus,
) -> SimulationTaskSnapshot {
    events_until(events, |snapshot| snapshot.status == status)
        .pop()
        .unwrap()
        .snapshot
}

fn cancel(host: &DesktopHost, task_id: u64) {
    let accepted = host
        .simulation
        .cancel_simulation(CancelSimulationRequest { task_id })
        .unwrap();
    assert_eq!(accepted.status, SimulationStatus::Cancelling);
    assert!(!accepted.cancel_retryable);
}

fn confirm(host: &DesktopHost, candidate: &ResultCandidateSession) {
    let response = host
        .results
        .confirm_result_session(ConfirmResultSessionRequest {
            session_id: candidate.session_id.clone(),
        })
        .unwrap();
    assert!(response.confirmed);
    assert_eq!(
        response.active_session_id.as_deref(),
        Some(candidate.session_id.as_str())
    );
}

fn save_request(candidate: &ResultCandidateSession, title: &str) -> SaveResultFieldsRequest {
    let mut fields = candidate.fields.clone();
    fields.title = title.into();
    SaveResultFieldsRequest {
        session_id: candidate.session_id.clone(),
        fields,
    }
}

fn result_path(host: &DesktopHost) -> PathBuf {
    host.simulation.last_completed_result_path().unwrap()
}

fn result_files(host: &DesktopHost) -> Vec<PathBuf> {
    fs::read_dir(host.results_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

fn temporary_result(host: &DesktopHost) -> PathBuf {
    result_files(host)
        .into_iter()
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(".tmp-")
        })
        .expect("temporary GSR")
}

#[test]
fn real_worker_commits_then_opens_a_result_and_replaces_its_old_sidecar() {
    let root = tempdir().unwrap();
    let (host, events) = host(root.path());
    assert_eq!(
        host.results.open_simulation_result().unwrap_err().code,
        DesktopErrorCode::NotFound
    );
    let started = host.simulation.start_simulation(request(20_000)).unwrap();
    assert_eq!(started.status, SimulationStatus::Starting);
    let observed = events_until(&events, |snapshot| {
        snapshot.status == SimulationStatus::Completed
    });
    assert_eq!(observed.first().unwrap().snapshot, started);
    assert!(observed
        .windows(2)
        .all(|pair| pair[0].seq + 1 == pair[1].seq));
    let phases: Vec<_> = observed.iter().map(|event| event.snapshot.status).collect();
    assert_eq!(phases[0], SimulationStatus::Starting);
    assert!(phases[1..phases.len() - 2]
        .iter()
        .all(|&phase| phase == SimulationStatus::Running));
    assert_eq!(phases[phases.len() - 2], SimulationStatus::Saving);
    assert_eq!(
        observed.last().unwrap().snapshot.total_result.as_deref(),
        Some("60000")
    );
    let progress: Vec<_> = observed
        .iter()
        .filter(|event| event.snapshot.status == SimulationStatus::Running)
        .map(|event| event.snapshot.completed_runs)
        .collect();
    assert_eq!(progress.last(), Some(&20_000));
    assert!(progress.windows(2).all(|pair| pair[0] < pair[1]));
    let path = result_path(&host);
    let filename = path.file_name().unwrap().to_str().unwrap();
    assert!(filename.starts_with("local-example-termination-score-"));
    assert!(filename.ends_with("-runs20000-seed-5-threads1.gsr"));
    assert_eq!(result_files(&host), std::slice::from_ref(&path));
    let original = fs::read(&path).unwrap();
    let opened = host.results.open_simulation_result().unwrap();
    assert_eq!(opened.filename, filename);
    assert_eq!(opened.analysis.totals.result, "60000");
    confirm(&host, &opened);
    host.results
        .save_result_fields(save_request(&opened, "saved"))
        .unwrap();

    let restarted = host.simulation.start_simulation(request(20_000)).unwrap();
    assert_eq!(restarted.task_id, Some(started.task_id.unwrap() + 1));
    assert_eq!(restarted.seq, observed.last().unwrap().seq + 1);
    status(&events, SimulationStatus::Completed);
    assert_eq!(result_path(&host), path);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(result_files(&host), std::slice::from_ref(&path));
    assert_eq!(
        host.results
            .save_result_fields(save_request(&opened, "stale edit"))
            .unwrap_err()
            .code,
        DesktopErrorCode::Conflict
    );
    let reopened = host.results.open_simulation_result().unwrap();
    assert_ne!(reopened.session_id, opened.session_id);
    assert_eq!(
        reopened.display,
        DisplayConfig::for_missing_sidecar(reopened.analysis.result_item.name)
    );
    host.shutdown().unwrap();
}

#[test]
fn real_worker_cooperatively_stops_after_progress_and_preserves_last_result() {
    let root = tempdir().unwrap();
    let (mut config, events) = host_config(root.path(), WORKER);
    let kills = Arc::new(AtomicUsize::new(0));
    config.worker_killer = {
        let kills = kills.clone();
        Arc::new(move |child| {
            kills.fetch_add(1, Ordering::Relaxed);
            child.kill()
        })
    };
    let host = DesktopHost::new(config, Arc::new(FixtureProvider)).unwrap();
    host.simulation.start_simulation(request(3)).unwrap();
    status(&events, SimulationStatus::Completed);
    let original = result_path(&host);
    let contents = fs::read(&original).unwrap();

    let running = host
        .simulation
        .start_simulation(request(100_000_000))
        .unwrap();
    events_until(&events, |snapshot| snapshot.completed_runs > 0);
    assert_eq!(
        host.simulation
            .start_simulation(request(1))
            .unwrap_err()
            .code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        host.simulation
            .cancel_simulation(CancelSimulationRequest {
                task_id: running.task_id.unwrap() - 1
            })
            .unwrap_err()
            .code,
        DesktopErrorCode::NotFound
    );
    cancel(&host, running.task_id.unwrap());
    let seen = events_until(&events, |snapshot| {
        snapshot.status == SimulationStatus::Cancelled
    });
    let cancelling = seen
        .iter()
        .position(|event| event.snapshot.status == SimulationStatus::Cancelling)
        .unwrap();
    let frozen = seen[cancelling].snapshot.completed_runs;
    assert!(seen[cancelling..]
        .iter()
        .all(|event| event.snapshot.completed_runs == frozen
            && matches!(
                event.snapshot.status,
                SimulationStatus::Cancelling | SimulationStatus::Cancelled
            )));
    assert_eq!(kills.load(Ordering::Relaxed), 0);
    assert_eq!(result_files(&host), std::slice::from_ref(&original));
    assert_eq!(fs::read(original).unwrap(), contents);
    host.shutdown().unwrap();
}

#[test]
fn cancellation_while_snapshot_is_loading_never_starts_a_worker() {
    struct BlockingProvider {
        entered: mpsc::Sender<()>,
        release: Mutex<Receiver<()>>,
    }

    impl ConfigSnapshotProvider for BlockingProvider {
        fn resolve_snapshot(
            &self,
            source: ConfigSource,
            id: &str,
        ) -> Result<ResolvedConfigSnapshot, DesktopError> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
            FixtureProvider.resolve_snapshot(source, id)
        }
    }

    let root = tempdir().unwrap();
    let (config, events) = host_config(root.path(), WORKER);
    let (entered, loading) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let host = DesktopHost::new(
        config,
        Arc::new(BlockingProvider {
            entered,
            release: Mutex::new(released),
        }),
    )
    .unwrap();
    let task = host.simulation.start_simulation(request(3)).unwrap();
    loading.recv_timeout(WAIT).unwrap();
    cancel(&host, task.task_id.unwrap());
    release.send(()).unwrap();
    status(&events, SimulationStatus::Cancelled);
    assert!(!host.results_dir().exists());
    host.shutdown().unwrap();
}

fn fake_binary() -> &'static Path {
    static FIXTURE: OnceLock<(TempDir, PathBuf)> = OnceLock::new();
    let (_, path) = FIXTURE.get_or_init(|| {
        let root = tempdir().unwrap();
        let path = root
            .path()
            .join(format!("worker-double{}", std::env::consts::EXE_SUFFIX));
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worker_double.rs");
        let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
        let output = Command::new(rustc)
            .arg("--edition=2021")
            .arg(source)
            .arg("-o")
            .arg(&path)
            .output()
            .expect("compile test worker");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        (root, path)
    });
    path
}

fn fake_host(
    root: &Path,
    killer: Option<WorkerKiller>,
) -> (DesktopHost, Receiver<SimulationTaskEvent>) {
    let worker = root.join(fake_binary().file_name().unwrap());
    fs::copy(fake_binary(), &worker).unwrap();
    let (mut config, events) = host_config(root, worker);
    config.cooperative_cancel_timeout = Duration::from_millis(40);
    config.force_kill_timeout = Duration::from_millis(100);
    if let Some(killer) = killer {
        config.worker_killer = killer;
    }
    (
        DesktopHost::new(config, Arc::new(FixtureProvider)).unwrap(),
        events,
    )
}

fn set_mode(root: &Path, mode: &str) {
    fs::write(root.join("mode"), mode).unwrap();
    let _ = fs::remove_file(root.join("ready"));
    let _ = fs::remove_file(root.join("release"));
}

#[test]
fn cancel_retries_force_kill_timeout_and_error_with_the_same_slot() {
    let root = tempdir().unwrap();
    let force_attempts = Arc::new(AtomicUsize::new(0));
    let killer = {
        let attempts = force_attempts.clone();
        Arc::new(
            move |child: &mut Child| match attempts.fetch_add(1, Ordering::Relaxed) {
                0 => Ok(()),
                1 => Err(io::Error::other("injected kill failure")),
                _ => child.kill(),
            },
        )
    };
    let (host, events) = fake_host(root.path(), Some(killer));
    set_mode(root.path(), "hang");
    let id = host
        .simulation
        .start_simulation(request(3))
        .unwrap()
        .task_id
        .unwrap();
    status(&events, SimulationStatus::Running);

    cancel(&host, id);
    let timed_out = events_until(&events, |snapshot| snapshot.cancel_retryable);
    assert!(timed_out
        .last()
        .unwrap()
        .snapshot
        .message
        .as_ref()
        .unwrap()
        .contains("did not exit"));
    assert!(timed_out
        .iter()
        .all(|event| event.snapshot.completed_runs == 0));
    assert!(temporary_result(&host).exists());
    assert_eq!(
        host.simulation
            .start_simulation(request(3))
            .unwrap_err()
            .code,
        DesktopErrorCode::Conflict
    );

    assert_eq!(
        host.shutdown().unwrap_err().code,
        DesktopErrorCode::CleanupBlocked
    );
    let failed_kill = events_until(&events, |snapshot| snapshot.cancel_retryable);
    assert!(failed_kill
        .last()
        .unwrap()
        .snapshot
        .message
        .as_ref()
        .unwrap()
        .contains("injected kill failure"));

    cancel(&host, id);
    status(&events, SimulationStatus::Cancelled);
    assert_eq!(force_attempts.load(Ordering::Relaxed), 3);
    assert!(result_files(&host).is_empty());
    host.shutdown().unwrap();
}

#[cfg(windows)]
#[test]
fn locked_temporary_file_retries_to_the_original_terminal_outcome() {
    use std::os::windows::fs::OpenOptionsExt;

    let root = tempdir().unwrap();
    let (host, events) = fake_host(root.path(), None);
    set_mode(root.path(), "success");
    host.simulation.start_simulation(request(3)).unwrap();
    status(&events, SimulationStatus::Completed);
    let previous = result_path(&host);

    for (mode, expected) in [
        ("cancel", SimulationStatus::Cancelled),
        ("write-error", SimulationStatus::Failed),
    ] {
        set_mode(root.path(), mode);
        let id = host
            .simulation
            .start_simulation(request(3))
            .unwrap()
            .task_id
            .unwrap();
        wait_for(|| root.path().join("ready").exists());
        let path = temporary_result(&host);
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        if mode == "cancel" {
            cancel(&host, id);
        } else {
            fs::write(root.path().join("release"), []).unwrap();
        }
        let blocked = events_until(&events, |snapshot| snapshot.cancel_retryable)
            .pop()
            .unwrap()
            .snapshot;
        assert_eq!(blocked.status, SimulationStatus::Cancelling);
        assert!(blocked
            .message
            .as_ref()
            .unwrap()
            .contains("Could not remove temporary GSR"));
        assert_eq!(
            host.simulation
                .start_simulation(request(3))
                .unwrap_err()
                .code,
            DesktopErrorCode::Conflict
        );
        drop(lock);
        cancel(&host, id);
        let settled = status(&events, expected);
        assert_eq!(
            settled.message.as_deref(),
            (mode == "write-error").then_some("simulated disk full")
        );
        assert!(!path.exists());
        assert_eq!(fs::read(&previous).unwrap(), KNOWN);
    }
    host.shutdown().unwrap();
}

#[test]
fn completion_event_needs_successful_exit_and_matching_metadata() {
    let root = tempdir().unwrap();
    let (host, events) = fake_host(root.path(), None);
    for mode in ["late-error", "bad-metadata"] {
        set_mode(root.path(), mode);
        host.simulation.start_simulation(request(3)).unwrap();
        if mode == "late-error" {
            status(&events, SimulationStatus::Saving);
            wait_for(|| root.path().join("ready").exists());
            assert_eq!(
                host.simulation.get_simulation_state().unwrap().status,
                SimulationStatus::Saving
            );
            assert!(host.simulation.last_completed_result_path().is_none());
            fs::write(root.path().join("release"), []).unwrap();
        }
        let failed = status(&events, SimulationStatus::Failed);
        if mode == "bad-metadata" {
            assert!(failed.message.unwrap().contains("trailer"));
        }
        assert!(result_files(&host).is_empty());
    }
    set_mode(root.path(), "success");
    host.simulation.start_simulation(request(3)).unwrap();
    status(&events, SimulationStatus::Completed);
    let previous = result_path(&host);
    set_mode(root.path(), "write-error");
    host.simulation.start_simulation(request(3)).unwrap();
    wait_for(|| root.path().join("ready").exists());
    fs::write(root.path().join("release"), []).unwrap();
    assert_eq!(
        status(&events, SimulationStatus::Failed).message.as_deref(),
        Some("simulated disk full")
    );
    assert_eq!(result_files(&host), std::slice::from_ref(&previous));
    assert_eq!(fs::read(previous).unwrap(), KNOWN);
    host.shutdown().unwrap();
}

#[test]
fn result_candidates_keep_the_active_session_until_confirmed_and_preserve_large_totals() {
    let root = tempdir().unwrap();
    let (host, _) = host(root.path());
    assert!(host.results.select_gsr_result(None).unwrap().is_none());
    assert_eq!(
        host.results
            .open_gsr_path(Path::new("relative.gsr"))
            .unwrap_err()
            .code,
        DesktopErrorCode::InvalidRequest
    );
    let known = root.path().join("known.gsr");
    let large = root.path().join("large-total.gsr");
    fs::write(&known, KNOWN).unwrap();
    fs::write(&large, LARGE).unwrap();

    let active = host.results.open_gsr_path(&known).unwrap();
    confirm(&host, &active);
    let stale = host.results.open_gsr_path(&large).unwrap();
    let pending = host.results.open_gsr_path(&large).unwrap();
    assert_ne!(stale.session_id, pending.session_id);
    assert_eq!(pending.analysis.totals.result, "9007199254740993");

    let response = host
        .results
        .confirm_result_session(ConfirmResultSessionRequest {
            session_id: stale.session_id,
        })
        .unwrap();
    assert!(!response.confirmed);
    assert_eq!(
        response.active_session_id.as_deref(),
        Some(active.session_id.as_str())
    );
    host.results
        .save_result_fields(save_request(&active, "still active"))
        .unwrap();

    confirm(&host, &pending);
    assert_eq!(
        host.results
            .save_result_fields(save_request(&active, "old"))
            .unwrap_err()
            .code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        host.results
            .discard_result_draft(DiscardResultDraftRequest {
                session_id: active.session_id
            })
            .unwrap_err()
            .code,
        DesktopErrorCode::Conflict
    );
    host.shutdown().unwrap();
}

#[test]
fn sidecar_save_is_atomic_retryable_and_uses_the_v2_defaults() {
    let root = tempdir().unwrap();
    let (host, _) = host(root.path());
    let path = root.path().join(format!("{}.gsr", "a".repeat(240)));
    let sidecar = path.with_extension("visualize.json");
    fs::write(&path, KNOWN).unwrap();
    let candidate = host.results.open_gsr_path(&path).unwrap();
    assert_eq!(
        candidate.display,
        DisplayConfig::for_missing_sidecar(&candidate.analysis.result_item.name)
    );
    assert!(candidate.display.note.starts_with("MEAN"));
    confirm(&host, &candidate);
    let saved = host
        .results
        .save_result_fields(save_request(&candidate, "first"))
        .unwrap();
    let original = fs::read(&sidecar).unwrap();
    assert!(original.ends_with(b"\n"));
    assert_eq!(
        DisplayConfig::from_sidecar_json(&original).unwrap(),
        saved.display
    );
    assert_eq!(saved.display.display_version, 2);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&sidecar)
            .unwrap();
        assert_eq!(
            host.results
                .save_result_fields(save_request(&candidate, "failed"))
                .unwrap_err()
                .code,
            DesktopErrorCode::Sidecar
        );
        assert_eq!(fs::read(&sidecar).unwrap(), original);
        drop(lock);
    }
    let mut invalid = save_request(&candidate, "invalid");
    invalid.fields.result_item_name.clear();
    assert_eq!(
        host.results.save_result_fields(invalid).unwrap_err().code,
        DesktopErrorCode::Sidecar
    );
    host.results
        .discard_result_draft(DiscardResultDraftRequest {
            session_id: candidate.session_id.clone(),
        })
        .unwrap();
    assert_eq!(fs::read(&sidecar).unwrap(), original);
    host.results
        .save_result_fields(save_request(&candidate, "retry"))
        .unwrap();
    assert_eq!(
        host.results.open_gsr_path(&path).unwrap().display.title,
        "retry"
    );
    assert_eq!(fs::read_dir(root.path()).unwrap().count(), 2);

    fs::write(&sidecar, b"invalid sidecar").unwrap();
    assert_eq!(
        host.results
            .save_result_fields(save_request(&candidate, "overwrite"))
            .unwrap_err()
            .code,
        DesktopErrorCode::Sidecar
    );
    assert_eq!(
        host.results.open_gsr_path(&path).unwrap_err().code,
        DesktopErrorCode::Sidecar
    );
    assert_eq!(fs::read(&sidecar).unwrap(), b"invalid sidecar");
    host.shutdown().unwrap();
}

#[test]
fn newer_result_open_and_shutdown_cancel_analyzers() {
    let root = tempdir().unwrap();
    let (host, _) = fake_host(root.path(), None);
    let blocked = root.path().join("blocked.gsr");
    let known = root.path().join("known.gsr");
    let analyzing = root.path().join("analyzing");
    fs::write(&blocked, KNOWN).unwrap();
    fs::write(&known, KNOWN).unwrap();
    thread::scope(|scope| {
        let first = scope.spawn(|| host.results.open_gsr_path(&blocked));
        wait_for(|| analyzing.exists());
        let candidate = host.results.open_gsr_path(&known).unwrap();
        assert_eq!(
            first.join().unwrap().unwrap_err().code,
            DesktopErrorCode::Cancelled
        );
        confirm(&host, &candidate);
        fs::remove_file(&analyzing).unwrap();
        let second = scope.spawn(|| host.results.open_gsr_path(&blocked));
        wait_for(|| analyzing.exists());
        host.shutdown().unwrap();
        assert_eq!(
            second.join().unwrap().unwrap_err().code,
            DesktopErrorCode::Cancelled
        );
    });
}

#[test]
fn worker_reports_real_output_errors_and_treats_stdin_eof_as_cancellation() {
    let root = tempdir().unwrap();
    let directory_target = root.path().join("directory.gsr");
    fs::create_dir(&directory_target).unwrap();
    let original = root.path().join("committed.gsr");
    fs::write(&original, KNOWN).unwrap();

    let mut job = WorkerSimulationJob {
        snapshot: config_package().snapshot,
        termination_file: "termination.yaml".into(),
        result_item: "score".into(),
        options: WorkerSimulationOptions {
            total_runs: 3,
            seed: -5,
            threads: 1,
            chunk_size: None,
            max_in_flight_chunks: None,
        },
        temp_output_path: directory_target.to_str().unwrap().to_owned(),
    };
    let launch = |job: &WorkerSimulationJob| {
        let mut child = Command::new(WORKER)
            .arg("simulate")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        serde_json::to_writer(&mut input, job).unwrap();
        input.write_all(b"\n").unwrap();
        (child, input)
    };
    let (child, input) = launch(&job);
    let output = child.wait_with_output().unwrap();
    drop(input);
    assert!(!output.status.success());
    let events: Vec<WorkerSimulationEvent> = BufReader::new(output.stdout.as_slice())
        .lines()
        .map(|line| serde_json::from_str(&line.unwrap()).unwrap())
        .collect();
    assert!(matches!(
        events.as_slice(),
        [
            WorkerSimulationEvent::Started,
            WorkerSimulationEvent::Error { .. }
        ]
    ));
    assert!(directory_target.is_dir());
    assert_eq!(fs::read(original).unwrap(), KNOWN);

    job.options.total_runs = 100_000_000;
    job.temp_output_path = root
        .path()
        .join("cancelled.gsr")
        .to_str()
        .unwrap()
        .to_owned();
    let (mut child, input) = launch(&job);
    let mut saw_progress = false;
    let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
    for line in stdout.by_ref() {
        let event: WorkerSimulationEvent = serde_json::from_str(&line.unwrap()).unwrap();
        if matches!(event, WorkerSimulationEvent::Progress { .. }) {
            saw_progress = true;
            break;
        }
    }
    assert!(saw_progress);
    drop(input);
    assert!(!child.wait().unwrap().success());
    assert!(stdout.all(|line| {
        let event: WorkerSimulationEvent = serde_json::from_str(&line.unwrap()).unwrap();
        !matches!(event, WorkerSimulationEvent::Completed { .. })
    }));
}

#[cfg(windows)]
#[test]
fn blocked_gsr_replacement_restores_the_old_sidecar() {
    use std::os::windows::fs::OpenOptionsExt;

    let root = tempdir().unwrap();
    let (host, events) = host(root.path());
    host.simulation.start_simulation(request(3)).unwrap();
    status(&events, SimulationStatus::Completed);
    let path = result_path(&host);
    let original = fs::read(&path).unwrap();
    let sidecar = path.with_extension("visualize.json");
    let candidate = host.results.open_simulation_result().unwrap();
    confirm(&host, &candidate);
    host.results
        .save_result_fields(save_request(&candidate, "kept"))
        .unwrap();
    let saved = fs::read(&sidecar).unwrap();

    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    host.simulation.start_simulation(request(3)).unwrap();
    status(&events, SimulationStatus::Failed);
    drop(lock);

    assert_eq!(result_path(&host), path);
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::read(&sidecar).unwrap(), saved);
    assert_eq!(result_files(&host).len(), 2);
    host.shutdown().unwrap();
}
