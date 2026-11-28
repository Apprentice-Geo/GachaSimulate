use std::{
    fs,
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
};

use gachasimulate_cli::{
    load_directory_snapshot, load_package_zip_snapshot, read_bounded_archive, read_dist_index,
    run_pipeline, sha256_hex,
};
use gachasimulate_config::{ConfigSnapshot, TerminationSource};
use gachasimulate_gsr::analyze_gsr_file;
use gachasimulate_runtime::SimulationOptions;
use zip::{write::SimpleFileOptions, CompressionMethod, System, ZipWriter};

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gachasimulate-1f-{label}-{}-{id}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn deterministic_end_to_end_pipeline_matches_exact_statistics() {
    let snapshot = ConfigSnapshot {
        manifest_yaml: "\
id: det_demo
name: Deterministic Demo
description: Exact pipeline check
terminations:
  - file: termination.yaml
    name: Done
"
        .into(),
        config_yaml: "\
schema_version: 2
items:
  - draw_count: 抽数
  - token: 代币
  - target: 目标
pools:
  - main:
      - probability: 1
        actions: token += 2
every_draw: draw_count += 1
item_resolve:
  - item: token
    retain: 1
    actions:
      - token -= 2
      - target += 1
"
        .into(),
        terminations: vec![TerminationSource {
            file: "termination.yaml".into(),
            content: "\
retained_items: []
termination_rule:
  condition:
    check: target >= 2
    actions: terminate got two targets
"
            .into(),
        }],
    };
    let temp = TempDir::new("deterministic");
    let gsr = temp.path().join("det.gsr");
    let options = SimulationOptions {
        total_runs: 100,
        seed: 123,
        threads: 4,
        chunk_size: Some(17),
        max_in_flight_chunks: Some(3),
    };
    let (summary, analysis) =
        run_pipeline(&snapshot, "termination.yaml", "draw_count", &options, &gsr).unwrap();
    assert_eq!(summary.total_runs, 100);
    assert_eq!(summary.total_result, 300);
    assert_eq!(analysis.result_item.id, "draw_count");
    assert_eq!(analysis.result_item.name, "抽数");
    assert_eq!(analysis.totals.runs, "100");
    assert_eq!(analysis.totals.result, "300");
    assert_eq!(analysis.values, ["3"]);
    assert_eq!(analysis.cumulative, [1.0]);
    assert_eq!(analysis.statistic.min, "3");
    assert_eq!(analysis.statistic.p50, "3");
    assert_eq!(analysis.statistic.mean, "3");
    assert_eq!(analysis.statistic.mean_level, 1.0);
    assert_eq!(analysis.statistic.max, "3");
    assert_eq!(analysis.termination_reason.len(), 1);
    assert_eq!(analysis.termination_reason[0].reason, "got two targets");
    assert_eq!(analysis.termination_reason[0].proportion, 100);
}

#[test]
fn geometric_distribution_pipeline_matches_analytical_expectation_and_is_thread_invariant() {
    let snapshot = ConfigSnapshot {
        manifest_yaml: "\
id: geom_demo
name: Geometric Demo
description: Analytical expectation test
terminations:
  - file: termination.yaml
    name: Hit
"
        .into(),
        config_yaml: "\
schema_version: 2
items:
  - draw_count: 抽数
  - hit: 命中
pools:
  - main:
      - probability: 0.25
        actions: hit += 1
      - probability: 0.75
every_draw: draw_count += 1
"
        .into(),
        terminations: vec![TerminationSource {
            file: "termination.yaml".into(),
            content: "\
retained_items: []
termination_rule:
  condition:
    check: hit >= 1
    actions: terminate hit
"
            .into(),
        }],
    };
    let temp = TempDir::new("geom");
    let gsr_1t = temp.path().join("geom_1t.gsr");
    let gsr_8t = temp.path().join("geom_8t.gsr");
    let opts_1t = SimulationOptions {
        total_runs: 100_000,
        seed: 123,
        threads: 1,
        chunk_size: None,
        max_in_flight_chunks: None,
    };
    let opts_8t = SimulationOptions {
        total_runs: 100_000,
        seed: 123,
        threads: 8,
        chunk_size: Some(1_000),
        max_in_flight_chunks: Some(4),
    };

    let (sum_1t, ana_1t) = run_pipeline(
        &snapshot,
        "termination.yaml",
        "draw_count",
        &opts_1t,
        &gsr_1t,
    )
    .unwrap();
    let (sum_8t, ana_8t) = run_pipeline(
        &snapshot,
        "termination.yaml",
        "draw_count",
        &opts_8t,
        &gsr_8t,
    )
    .unwrap();

    assert_eq!(sum_1t.total_result, sum_8t.total_result);
    assert_eq!(ana_1t, ana_8t);

    let empirical_mean = sum_1t.total_result as f64 / 100_000.0;
    assert!(
        (empirical_mean - 4.0).abs() < 0.05,
        "empirical mean {empirical_mean} drifted from 4.0"
    );
    assert_eq!(ana_1t.values[0], "1");
    assert!(
        (ana_1t.cumulative[0] - 0.25).abs() < 0.01,
        "P(X <= 1) = {} drifted from 0.25",
        ana_1t.cumulative[0]
    );
}

#[test]
fn cli_preserves_existing_gsr_on_failure_blocks_input_aliasing_and_ignores_extra_files() {
    let temp = TempDir::new("cli-safety");
    let cfg_dir = temp.path();
    fs::write(
        cfg_dir.join("manifest.yaml"),
        "id: demo\nname: Demo\ndescription: Test\nterminations:\n  - file: termination.yaml\n    name: Done\n",
    )
    .unwrap();
    fs::write(
        cfg_dir.join("config.yaml"),
        "schema_version: 2\nitems: [draw_count, target]\npools:\n  - main:\n      - probability: 1\n        actions: target += 1\nevery_draw: draw_count += 1\n",
    )
    .unwrap();
    fs::write(
        cfg_dir.join("termination.yaml"),
        "retained_items: []\ntermination_rule:\n  condition:\n    check: target >= 1\n    actions: terminate done\n",
    )
    .unwrap();

    let cli = env!("CARGO_BIN_EXE_gachasimulate-cli");
    // Write result.gsr directly inside the config directory.
    let gsr_path = cfg_dir.join("result.gsr");
    let status = Command::new(cli)
        .args([
            "simulate",
            "--config-dir",
            cfg_dir.to_str().unwrap(),
            "--runs",
            "10",
            "--threads",
            "1",
            "--output",
            gsr_path.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());
    let valid_bytes = fs::read(&gsr_path).unwrap();

    // Rerunning with --threads 0 must fail AND preserve the existing valid result.gsr,
    // and loading the config dir must ignore the binary result.gsr next to the YAMLs.
    let failed = Command::new(cli)
        .args([
            "simulate",
            "--config-dir",
            cfg_dir.to_str().unwrap(),
            "--runs",
            "10",
            "--threads",
            "0",
            "--output",
            gsr_path.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(!failed.success());
    assert_eq!(fs::read(&gsr_path).unwrap(), valid_bytes);
    analyze_gsr_file(&gsr_path).unwrap();
    load_directory_snapshot(cfg_dir).unwrap();

    // Analyzing with --output aliasing --input must be rejected without clobbering result.gsr.
    let aliased = Command::new(cli)
        .args([
            "analyze",
            "--input",
            gsr_path.to_str().unwrap(),
            "--output",
            gsr_path.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(!aliased.success());
    assert_eq!(fs::read(&gsr_path).unwrap(), valid_bytes);
}

#[test]
fn zip_loader_rejects_duplicate_entries_and_symlinks() {
    // Duplicate entry names in ZIP.
    let mut buf = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut buf);
        let opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .system(System::Unix)
            .unix_permissions(0o644);
        writer.start_file("manifest.yaml", opts).unwrap();
        writer
            .write_all(b"id: demo\nname: D\ndescription: ''\nterminations: [{file: termination.yaml, name: T}]\n")
            .unwrap();
        writer.start_file("config.yaml", opts).unwrap();
        writer.write_all(b"schema_version: 2\n").unwrap();
        writer.start_file("config.yamX", opts).unwrap();
        writer.write_all(b"schema_version: 2\n").unwrap();
        writer.start_file("termination.yaml", opts).unwrap();
        writer.write_all(b"retained_items: []\n").unwrap();
        writer.finish().unwrap();
    }
    let mut raw_zip = buf.into_inner();
    // Rename `config.yamX` -> `config.yaml` in both local header and central directory
    // so the archive genuinely contains two duplicate `config.yaml` entries.
    let needle = b"config.yamX";
    let mut patched = 0usize;
    for pos in 0..=raw_zip.len() - needle.len() {
        if &raw_zip[pos..pos + needle.len()] == needle {
            raw_zip[pos + needle.len() - 1] = b'l';
            patched += 1;
        }
    }
    assert_eq!(patched, 2);
    let err = load_package_zip_snapshot("demo", &raw_zip).unwrap_err();
    assert!(err.contains("duplicate"), "unexpected error: {err}");

    // Symlink entry in ZIP.
    let mut sym_buf = Cursor::new(Vec::new());
    {
        let mut writer = ZipWriter::new(&mut sym_buf);
        let file_opts = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .system(System::Unix)
            .unix_permissions(0o644);
        writer.start_file("manifest.yaml", file_opts).unwrap();
        writer
            .write_all(b"id: demo\nname: D\ndescription: ''\nterminations: [{file: termination.yaml, name: T}]\n")
            .unwrap();
        writer.start_file("config.yaml", file_opts).unwrap();
        writer.write_all(b"schema_version: 2\n").unwrap();
        writer
            .add_symlink("termination.yaml", "other.yaml", file_opts)
            .unwrap();
        writer.finish().unwrap();
    }
    let err = load_package_zip_snapshot("demo", &sym_buf.into_inner()).unwrap_err();
    assert!(
        err.contains("not a regular file") || err.contains("non-regular"),
        "unexpected error: {err}"
    );
}

#[test]
#[ignore = "requires GACHASIMULATE_CONFIGS_DIST to point at GachaSimulate-Configs/dist"]
fn official_1e_packages_validate_compile_simulate_and_analyze_end_to_end() {
    let dist_dir = PathBuf::from(
        std::env::var("GACHASIMULATE_CONFIGS_DIST")
            .expect("GACHASIMULATE_CONFIGS_DIST must be set"),
    );
    let index = read_dist_index(&dist_dir).unwrap();
    assert_eq!(index.configs.len(), 16);

    // Pinned statistical sanity windows (mean draw count) verified against the
    // existing C++ engine and analytical expectations for representative official configs.
    let expected_mean_bounds: &[(&str, &str, u64, u64)] = &[
        (
            "sanguosha_mengzhihuilang_8_last24",
            "termination.yaml",
            55,
            85,
        ),
        (
            "sanguosha_mengzhihuilang_4_last24",
            "termination.yaml",
            75,
            115,
        ),
        (
            "wangzhe_sanrio_sunshangxiang",
            "termination_skin.yaml",
            65,
            95,
        ),
        ("wangzhe_wenxinjian_lixin", "termination_skin.yaml", 35, 55),
        (
            "wangzhe_zhenpinchuanshuo_nezha2",
            "termination_skin.yaml",
            30,
            50,
        ),
    ];

    let temp = TempDir::new("official-1e");
    let mut total_terminations = 0usize;
    let mut checked_bounds = 0usize;
    for entry in &index.configs {
        let zip_path = dist_dir.join(&entry.download_url);
        let zip_bytes = read_bounded_archive(&zip_path).unwrap();
        assert_eq!(
            sha256_hex(&zip_bytes),
            entry.sha256,
            "SHA-256 mismatch for {}",
            entry.id
        );
        let (manifest, snapshot) = load_package_zip_snapshot(&entry.id, &zip_bytes).unwrap();
        assert_eq!(manifest.id, entry.id);

        for termination in &manifest.terminations {
            total_terminations += 1;
            let gsr = temp
                .path()
                .join(format!("{}-{total_terminations}.gsr", entry.id));
            let options = SimulationOptions {
                total_runs: 2_000,
                seed: 123,
                threads: 4,
                chunk_size: None,
                max_in_flight_chunks: None,
            };
            let (summary, analysis) =
                run_pipeline(&snapshot, &termination.file, "draw_count", &options, &gsr).unwrap();
            assert_eq!(summary.total_runs, 2_000);
            assert_eq!(analysis.totals.runs, "2000");
            assert_eq!(analysis.totals.result, summary.total_result.to_string());
            let mean: u64 = analysis.statistic.mean.parse().unwrap();
            let p50: u64 = analysis.statistic.p50.parse().unwrap();
            assert!(mean > 0 && p50 > 0);
            if let Some(&(_, _, lo, hi)) = expected_mean_bounds
                .iter()
                .find(|&&(id, file, _, _)| id == entry.id && file == termination.file)
            {
                assert!(
                    (lo..=hi).contains(&mean),
                    "{} / {} mean {} outside expected [{}, {}]",
                    entry.id,
                    termination.file,
                    mean,
                    lo,
                    hi
                );
                checked_bounds += 1;
            }
        }
    }
    assert_eq!(total_terminations, 34);
    assert_eq!(checked_bounds, expected_mean_bounds.len());
}
