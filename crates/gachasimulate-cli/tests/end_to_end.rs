use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use gachasimulate_cli::{
    load_package_zip_snapshot, read_dist_index, read_file_bytes, run_pipeline,
};
use gachasimulate_config::{ConfigSnapshot, TerminationSource};
use gachasimulate_runtime::SimulationOptions;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TempGsr(PathBuf);

impl TempGsr {
    fn new(label: &str) -> Self {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "gachasimulate-1f-{label}-{}-{id}.gsr",
            std::process::id()
        ));
        let _ = fs::remove_file(&path);
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempGsr {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
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
    // Draw 1: token=2 -> retain 1, excess=1 < 2 -> no resolve (target=0)
    // Draw 2: token=4 -> excess=3 -> 1 batch -> token=2, target=1
    // Draw 3: token=4 -> excess=3 -> 1 batch -> token=2, target=2 -> terminate!
    // Every run finishes in exactly 3 draws.
    let gsr = TempGsr::new("deterministic");
    let options = SimulationOptions {
        total_runs: 100,
        seed: 123,
        threads: 4,
        chunk_size: Some(17),
        max_in_flight_chunks: Some(3),
    };
    let (summary, analysis) = run_pipeline(
        &snapshot,
        "termination.yaml",
        "draw_count",
        &options,
        gsr.path(),
    )
    .unwrap();
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
    // Geometric(p = 0.25): E[X] = 4, P(X <= 1) = 0.25, P(X <= 4) = 1 - 0.75^4 = 0.68359375.
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
    let gsr_1t = TempGsr::new("geom-1t");
    let gsr_8t = TempGsr::new("geom-8t");
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
        gsr_1t.path(),
    )
    .unwrap();
    let (sum_8t, ana_8t) = run_pipeline(
        &snapshot,
        "termination.yaml",
        "draw_count",
        &opts_8t,
        gsr_8t.path(),
    )
    .unwrap();

    // Thread/chunk invariance: identical totals & identical Analysis.
    assert_eq!(sum_1t.total_result, sum_8t.total_result);
    assert_eq!(ana_1t, ana_8t);

    // Analytical checks: E[X] = 4.0 (within 0.05 for 100k runs), P(X <= 1) ~= 0.25.
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
#[ignore = "requires GACHASIMULATE_CONFIGS_DIST to point at GachaSimulate-Configs/dist"]
fn official_1e_packages_validate_compile_simulate_and_analyze_end_to_end() {
    let dist_dir = PathBuf::from(
        std::env::var("GACHASIMULATE_CONFIGS_DIST")
            .expect("GACHASIMULATE_CONFIGS_DIST must be set"),
    );
    let index = read_dist_index(&dist_dir).unwrap();
    assert!(!index.configs.is_empty());

    let mut total_terminations = 0usize;
    for entry in &index.configs {
        let zip_path = dist_dir.join(&entry.download_url);
        let zip_bytes = read_file_bytes(&zip_path).unwrap();
        let (manifest, snapshot) = load_package_zip_snapshot(&entry.id, &zip_bytes).unwrap();
        assert_eq!(manifest.id, entry.id);

        for termination in &manifest.terminations {
            total_terminations += 1;
            let gsr = TempGsr::new(&format!("{}-{}", entry.id, total_terminations));
            let options = SimulationOptions {
                total_runs: 2_000,
                seed: 123,
                threads: 4,
                chunk_size: None,
                max_in_flight_chunks: None,
            };
            let (summary, analysis) = run_pipeline(
                &snapshot,
                &termination.file,
                "draw_count",
                &options,
                gsr.path(),
            )
            .unwrap();
            assert_eq!(summary.total_runs, 2_000);
            assert_eq!(analysis.totals.runs, "2000");
            assert_eq!(analysis.totals.result, summary.total_result.to_string());
            println!(
                "1F OK: {} / {} -> runs={}, total_result={}, P50={}, MEAN={}",
                entry.id,
                termination.file,
                analysis.totals.runs,
                analysis.totals.result,
                analysis.statistic.p50,
                analysis.statistic.mean
            );
        }
    }
    println!(
        "1F COMPLETE: {} packages, {} terminations verified end-to-end",
        index.configs.len(),
        total_terminations
    );
}
