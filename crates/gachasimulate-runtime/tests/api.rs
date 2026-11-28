use std::time::{Duration, Instant};

use gachasimulate_runtime::{
    run_single_deterministic, simulate_to_writer, CancelToken, ResultChunkWriter, SimulationError,
    SimulationOptions, SimulationProgress, MAX_CHUNK_RECORDS, MAX_RUNS,
};
use gachasimulate_types::{
    fixtures::{deterministic_program, MemoryChunkWriter},
    Action, ActionRange, Comparison, CompiledProgram, ConditionNode, GsrError, GsrHeaderMeta,
    GsrWriteSummary, LogicOp, PoolEntry, ResultChunk, ResultRecord, Rule, RuleMode,
};

fn options() -> SimulationOptions {
    SimulationOptions {
        total_runs: 19,
        seed: -5,
        threads: 4,
        chunk_size: Some(3),
        max_in_flight_chunks: Some(2),
    }
}

fn random_program() -> CompiledProgram {
    let mut program = deterministic_program();
    program.initial = ActionRange::EMPTY;
    program.reasons.push("other".into());
    program.actions.extend([
        Action::AddItem { item: 0, amount: 4 },
        Action::AddItem { item: 0, amount: 2 },
        Action::Terminate { reason: 1 },
    ]);
    program.pool_entries[0].threshold = 0.5;
    program.pool_entries.push(PoolEntry {
        threshold: 1.0,
        actions: ActionRange::new(4, 1),
    });
    program.pools[0].entries.count = 2;
    program.condition_nodes = vec![
        ConditionNode::Check {
            item: 0,
            op: Comparison::Eq,
            value: 8,
            actions: ActionRange::new(3, 1),
        },
        ConditionNode::Check {
            item: 0,
            op: Comparison::Gt,
            value: 8,
            actions: ActionRange::new(6, 1),
        },
        ConditionNode::Logic {
            op: LogicOp::Or,
            children: ActionRange::new(0, 2),
            actions: ActionRange::EMPTY,
        },
        ConditionNode::Check {
            item: 0,
            op: Comparison::Ge,
            value: 1,
            actions: ActionRange::new(5, 1),
        },
    ];
    program.condition_children = vec![0, 1];
    program.termination_condition = 2;
    program.rules.push(Rule {
        id: "bonus".into(),
        mode: RuleMode::Once,
        condition: 3,
    });
    program
}

fn collect_batch(
    program: &CompiledProgram,
    options: &SimulationOptions,
    expected_chunk_size: u64,
) -> Vec<ResultRecord> {
    let meta = GsrHeaderMeta::from_program(program, options).unwrap();
    let mut chunks = Vec::new();
    let writer = MemoryChunkWriter::new(&meta, &mut chunks);
    let mut progress = Vec::new();
    let summary = simulate_to_writer(program, options, &CancelToken::new(), writer, |update| {
        progress.push(update);
    })
    .unwrap();
    assert_eq!(summary.total_runs, options.total_runs);
    assert_eq!(
        summary.chunks_written,
        options.total_runs.div_ceil(expected_chunk_size)
    );
    assert_eq!(progress.len() as u64, summary.chunks_written);
    assert_eq!(chunks.len(), progress.len());

    let mut all_records = Vec::new();
    for (chunk, update) in chunks.into_iter().zip(progress) {
        assert_eq!(chunk.start_run, all_records.len() as u64);
        assert_eq!(
            chunk.records.len() as u64,
            expected_chunk_size.min(options.total_runs - chunk.start_run)
        );
        all_records.extend(chunk.records);
        assert_eq!(
            update,
            SimulationProgress {
                completed_runs: all_records.len() as u64,
                total_runs: options.total_runs,
            }
        );
    }
    assert_eq!(
        summary.total_result,
        all_records.iter().map(|record| record.value).sum::<u64>()
    );
    all_records
}

#[test]
fn records_are_ordered_and_stable_across_schedules_and_prefixes() {
    let program = random_program();
    let mut options = options();
    let mut expected: Vec<_> = (0..257)
        .rev()
        .map(|index| run_single_deterministic(&program, options.seed, index).unwrap())
        .collect();
    expected.reverse();
    assert!(expected.iter().any(|record| record.reason_index == 0));
    assert!(expected.iter().any(|record| record.reason_index == 1));

    for threads in [1, 4, 8] {
        for chunk_size in [1, 3, 17, 100] {
            options.threads = threads;
            options.chunk_size = Some(chunk_size);
            options.max_in_flight_chunks = None;
            options.total_runs = 113;
            assert_eq!(
                collect_batch(&program, &options, chunk_size),
                expected[..113]
            );
            options.total_runs = 257;
            assert_eq!(collect_batch(&program, &options, chunk_size), expected);
        }
    }
}

#[test]
fn default_parallel_chunks_report_intermediate_progress() {
    let program = deterministic_program();
    let options = SimulationOptions {
        total_runs: 10_000,
        threads: 16,
        chunk_size: None,
        max_in_flight_chunks: None,
        ..options()
    };
    // The helper checks every progress update, including the first at 313 runs.
    assert_eq!(collect_batch(&program, &options, 313).len(), 10_000);
}

#[test]
fn default_chunks_and_single_slot_windows() {
    let program = deterministic_program();
    let mut options = options();
    options.threads = gachasimulate_runtime::MAX_THREADS;
    options.chunk_size = None;
    options.max_in_flight_chunks = None;
    assert_eq!(
        collect_batch(&program, &options, 1).len() as u64,
        options.total_runs
    );
    options.chunk_size = Some(1);
    options.max_in_flight_chunks = Some(1);
    assert_eq!(
        collect_batch(&program, &options, 1).len() as u64,
        options.total_runs
    );
    options.threads = usize::MAX;
    assert!(matches!(
        simulate_rejected(
            &program,
            &options,
            &CancelToken::new(),
            GsrHeaderMeta::from_program(&program, &options).unwrap(),
        ),
        SimulationError::InvalidOptions { .. }
    ));
}

#[derive(Default)]
struct WriterCalls {
    starts: Vec<u64>,
    finished: bool,
}

struct ObservedWriter<'a> {
    meta: GsrHeaderMeta,
    calls: &'a mut WriterCalls,
    fail_at: Option<u64>,
}

impl ResultChunkWriter for ObservedWriter<'_> {
    fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    fn write_chunk(&mut self, chunk: &ResultChunk) -> Result<(), GsrError> {
        self.calls.starts.push(chunk.start_run);
        if self.fail_at == Some(chunk.start_run) {
            return Err(GsrError::Io(std::io::Error::other(
                "injected write failure",
            )));
        }
        Ok(())
    }

    fn finish(self) -> Result<GsrWriteSummary, GsrError> {
        self.calls.finished = true;
        Ok(GsrWriteSummary {
            total_runs: self.meta.total_runs,
            total_result: 0,
            chunks_written: self.calls.starts.len() as u64,
            file_size: 0,
        })
    }
}

fn simulate_rejected(
    program: &CompiledProgram,
    options: &SimulationOptions,
    cancel: &CancelToken,
    meta: GsrHeaderMeta,
) -> SimulationError {
    let mut calls = WriterCalls::default();
    let writer = ObservedWriter {
        meta,
        calls: &mut calls,
        fail_at: None,
    };
    let error = simulate_to_writer(program, options, cancel, writer, |_| {
        panic!("unexpected progress");
    })
    .unwrap_err();
    assert!(calls.starts.is_empty());
    assert!(!calls.finished);
    error
}

#[test]
fn validates_program_options_and_metadata_before_processing() {
    let program = deterministic_program();
    let options = options();
    let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
    let cancel = CancelToken::new();
    for invalid in [
        SimulationOptions {
            total_runs: 0,
            ..options.clone()
        },
        SimulationOptions {
            total_runs: MAX_RUNS + 1,
            ..options.clone()
        },
        SimulationOptions {
            threads: 0,
            ..options.clone()
        },
        SimulationOptions {
            chunk_size: Some(0),
            ..options.clone()
        },
        SimulationOptions {
            chunk_size: Some(MAX_CHUNK_RECORDS as u64 + 1),
            ..options.clone()
        },
        SimulationOptions {
            max_in_flight_chunks: Some(0),
            ..options.clone()
        },
    ] {
        assert!(matches!(
            simulate_rejected(&program, &invalid, &cancel, meta.clone()),
            SimulationError::InvalidOptions { .. }
        ));
    }

    let mut invalid_program = program.clone();
    invalid_program.pool_entries[0].actions = ActionRange::new(u32::MAX, 1);
    assert!(matches!(
        simulate_rejected(&invalid_program, &options, &cancel, meta.clone()),
        SimulationError::InvalidProgram(_)
    ));

    let mut runtime_error_program = program;
    runtime_error_program.actions[1] = Action::AddItem {
        item: 0,
        amount: i64::MAX,
    };
    for mismatch in [
        GsrHeaderMeta {
            total_runs: 20,
            ..meta.clone()
        },
        GsrHeaderMeta {
            seed: 5,
            ..meta.clone()
        },
        GsrHeaderMeta {
            result_item_id: "other".into(),
            ..meta.clone()
        },
        GsrHeaderMeta {
            result_item_name: "other".into(),
            ..meta.clone()
        },
        GsrHeaderMeta {
            reasons: vec!["other".into()],
            ..meta.clone()
        },
    ] {
        assert!(matches!(
            simulate_rejected(&runtime_error_program, &options, &cancel, mismatch),
            SimulationError::HeaderMismatch
        ));
    }
}

#[test]
fn pre_cancelled_batch_has_no_writer_calls() {
    let program = deterministic_program();
    for threads in [1, 4] {
        let options = SimulationOptions {
            threads,
            ..options()
        };
        let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
        let cancel = CancelToken::new();
        cancel.cancel();
        assert!(matches!(
            simulate_rejected(&program, &options, &cancel, meta),
            SimulationError::Cancelled
        ));
    }
}

#[test]
fn cancellation_from_progress_stops_after_the_accepted_chunk() {
    let program = deterministic_program();
    for threads in [1, 4] {
        for (total_runs, cancel_after, expected_starts) in [(19, 3, vec![0]), (4, 4, vec![0, 3])] {
            let options = SimulationOptions {
                threads,
                total_runs,
                ..options()
            };
            let mut calls = WriterCalls::default();
            let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
            let writer = ObservedWriter {
                meta,
                calls: &mut calls,
                fail_at: None,
            };
            let cancel = CancelToken::new();
            let start = Instant::now();
            let error = simulate_to_writer(&program, &options, &cancel, writer, |update| {
                if update.completed_runs == cancel_after {
                    cancel.cancel();
                }
            })
            .unwrap_err();
            assert!(matches!(error, SimulationError::Cancelled));
            assert!(start.elapsed() < Duration::from_secs(5));
            assert_eq!(calls.starts, expected_starts);
            assert!(!calls.finished);
        }
    }
}

#[test]
fn writer_failure_aborts_without_finishing_or_reporting_the_failed_chunk() {
    let program = deterministic_program();
    for threads in [1, 4] {
        let options = SimulationOptions {
            threads,
            ..options()
        };
        let mut calls = WriterCalls::default();
        let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
        let writer = ObservedWriter {
            meta,
            calls: &mut calls,
            fail_at: Some(3),
        };
        let mut progress = Vec::new();
        let error = simulate_to_writer(&program, &options, &CancelToken::new(), writer, |update| {
            progress.push(update.completed_runs);
        })
        .unwrap_err();
        assert!(matches!(error, SimulationError::Writer(GsrError::Io(error))
            if error.to_string() == "injected write failure"));
        assert_eq!(calls.starts, [0, 3]);
        assert_eq!(progress, [3]);
        assert!(!calls.finished);
    }
}

#[test]
fn failed_run_preserves_only_whole_preceding_chunks_and_skips_finish() {
    let mut program = random_program();
    // Selecting the lower interval now overflows.
    program.actions[2] = Action::AddItem {
        item: 0,
        amount: i64::MAX,
    };
    let first_error = (0..100)
        .find(|&index| run_single_deterministic(&program, 0, index).is_err())
        .unwrap();
    assert!(first_error > 0);
    for threads in [1, 4] {
        let options = SimulationOptions {
            threads,
            total_runs: 100,
            seed: 0,
            chunk_size: Some(1),
            ..options()
        };
        let mut calls = WriterCalls::default();
        let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
        let writer = ObservedWriter {
            meta,
            calls: &mut calls,
            fail_at: None,
        };
        let error = simulate_to_writer(&program, &options, &CancelToken::new(), writer, |_| {})
            .unwrap_err();
        assert!(
            matches!(error, SimulationError::InventoryOverflow { run_index, item: 0 }
            if run_index == first_error)
        );
        assert_eq!(calls.starts, (0..first_error).collect::<Vec<_>>());
        assert!(!calls.finished);
    }
}
