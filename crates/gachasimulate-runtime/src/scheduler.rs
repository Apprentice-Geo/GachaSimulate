use std::{
    collections::BTreeMap,
    panic::{self, AssertUnwindSafe},
    sync::{
        atomic::{AtomicU64, Ordering},
        Condvar, Mutex,
    },
    thread,
    time::Duration,
};

use gachasimulate_types::{GsrHeaderMeta, ResultChunk};

use crate::{
    run::{RunControl, Scratch},
    CancelToken, CompiledProgram, GsrWriteSummary, ResultChunkWriter, SimulationError,
    SimulationOptions, SimulationProgress, MAX_CHUNK_RECORDS, MAX_RUNS,
};

pub const MAX_THREADS: usize = 256;
const DEFAULT_CHUNK_SIZE: u64 = 16_384;
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(10);
const NO_FAILURE: u64 = u64::MAX;

type ChunkResult = Result<ResultChunk, SimulationError>;

/// Runs the program with a bounded window of chunks and submits them in run
/// order. Before executing any runs, verifies that `writer.metadata()` matches
/// `GsrHeaderMeta::from_program(program, options)`. Progress reports runs
/// accepted by the writer. A chunk occupies its window slot through writing
/// and progress reporting. Run errors surface in run order. The caller's
/// cancellation takes precedence over execution and write errors observed
/// before finalization. Only a complete batch calls the writer's finish method.
pub fn simulate_to_writer<W: ResultChunkWriter, F: FnMut(SimulationProgress) + Send>(
    program: &CompiledProgram,
    options: &SimulationOptions,
    cancel: &CancelToken,
    mut writer: W,
    mut on_progress: F,
) -> Result<GsrWriteSummary, SimulationError> {
    program.validate_invariants()?;
    let batch = Batch::new(program, options, cancel)?;
    if *writer.metadata() != GsrHeaderMeta::from_program(program, options)? {
        return Err(SimulationError::HeaderMismatch);
    }
    check_cancelled(cancel)?;

    let mut write = |chunk: &ResultChunk| {
        check_cancelled(cancel)?;
        writer.write_chunk(chunk)?;
        on_progress(SimulationProgress {
            completed_runs: chunk.start_run + chunk.records.len() as u64,
            total_runs: options.total_runs,
        });
        check_cancelled(cancel)
    };
    let result = if batch.workers == 1 {
        batch.run_sequential(write)
    } else {
        batch.run_parallel(&mut write, |start, scratch, control| {
            batch.compute_chunk(start, scratch, control)
        })
    };
    check_cancelled(cancel)?;
    result?;
    Ok(writer.finish()?)
}

fn check_cancelled(cancel: &CancelToken) -> Result<(), SimulationError> {
    if cancel.is_cancelled() {
        return Err(SimulationError::Cancelled);
    }
    Ok(())
}

fn invalid_options(message: impl Into<String>) -> SimulationError {
    SimulationError::InvalidOptions {
        message: message.into(),
    }
}

struct Batch<'a> {
    program: &'a CompiledProgram,
    options: &'a SimulationOptions,
    cancel: &'a CancelToken,
    chunk_size: u64,
    chunks: u64,
    window_size: u64,
    workers: usize,
}

impl<'a> Batch<'a> {
    fn new(
        program: &'a CompiledProgram,
        options: &'a SimulationOptions,
        cancel: &'a CancelToken,
    ) -> Result<Self, SimulationError> {
        if !(1..=MAX_RUNS).contains(&options.total_runs) {
            return Err(invalid_options(format!(
                "total_runs must be in 1..={MAX_RUNS}"
            )));
        }
        if !(1..=MAX_THREADS).contains(&options.threads) {
            return Err(invalid_options(format!(
                "threads must be in 1..={MAX_THREADS}"
            )));
        }
        let max_chunk_size = MAX_CHUNK_RECORDS as u64;
        let chunk_size = options.chunk_size.unwrap_or_else(|| {
            let target_chunks = if options.threads == 1 {
                1
            } else {
                (options.threads as u64).saturating_mul(2)
            };
            options
                .total_runs
                .div_ceil(target_chunks)
                .min(DEFAULT_CHUNK_SIZE.min(max_chunk_size))
        });
        if !(1..=max_chunk_size).contains(&chunk_size) {
            return Err(invalid_options(format!(
                "chunk_size must be in 1..={max_chunk_size}"
            )));
        }
        let window_size = options
            .max_in_flight_chunks
            .unwrap_or_else(|| options.threads.saturating_mul(2).max(2));
        if window_size == 0 {
            return Err(invalid_options("max_in_flight_chunks must be positive"));
        }
        let chunk_size = chunk_size.min(options.total_runs);
        let chunks = options.total_runs.div_ceil(chunk_size);
        Ok(Self {
            program,
            options,
            cancel,
            chunk_size,
            chunks,
            window_size: window_size as u64,
            workers: options.threads.min(chunks as usize).min(window_size),
        })
    }

    fn compute_chunk(
        &self,
        start_run: u64,
        scratch: &mut Scratch,
        control: RunControl<'_>,
    ) -> ChunkResult {
        let end = (start_run + self.chunk_size).min(self.options.total_runs);
        let mut records = Vec::with_capacity((end - start_run) as usize);
        for run_index in start_run..end {
            records.push(scratch.run(self.program, self.options.seed, run_index, Some(control))?);
        }
        Ok(ResultChunk { start_run, records })
    }

    fn run_sequential(
        &self,
        mut write: impl FnMut(&ResultChunk) -> Result<(), SimulationError>,
    ) -> Result<(), SimulationError> {
        let control = RunControl {
            cancel: self.cancel,
            stop_at: None,
        };
        let mut scratch = Scratch::new(self.program);
        for index in 0..self.chunks {
            write(&self.compute_chunk(index * self.chunk_size, &mut scratch, control)?)?;
        }
        Ok(())
    }

    fn run_parallel(
        &self,
        mut write: impl FnMut(&ResultChunk) -> Result<(), SimulationError>,
        compute: impl Fn(u64, &mut Scratch, RunControl<'_>) -> ChunkResult + Sync,
    ) -> Result<(), SimulationError> {
        let window = Window::default();
        thread::scope(|scope| {
            // Wake blocked workers before the scope joins them, including on
            // a writer/callback panic or a partially spawned thread pool.
            let _abort_on_exit = AbortOnExit(&window);
            for _ in 0..self.workers {
                check_cancelled(self.cancel)?;
                if window.stop_at.load(Ordering::Relaxed) != NO_FAILURE {
                    break;
                }
                let (window, compute) = (&window, &compute);
                thread::Builder::new()
                    .spawn_scoped(scope, move || {
                        let result = panic::catch_unwind(AssertUnwindSafe(|| {
                            self.worker(window, compute);
                        }));
                        if let Err(payload) = result {
                            window.abort();
                            panic::resume_unwind(payload);
                        }
                    })
                    .map_err(|error| invalid_options(format!("could not start worker: {error}")))?;
            }

            for index in 0..self.chunks {
                let chunk = window.take(index, self.cancel)?;
                write(&chunk)?;
                // The buffer itself must be gone before this slot can be claimed again.
                drop(chunk);
                window.written(index);
            }
            Ok(())
        })
    }

    fn worker(
        &self,
        window: &Window,
        compute: &impl Fn(u64, &mut Scratch, RunControl<'_>) -> ChunkResult,
    ) {
        let control = RunControl {
            cancel: self.cancel,
            stop_at: Some(&window.stop_at),
        };
        let mut scratch = Scratch::new(self.program);
        while let Some(index) = window.claim(self) {
            let start = index * self.chunk_size;
            let result = compute(start, &mut scratch, control);
            if matches!(result, Err(SimulationError::Cancelled)) {
                break;
            }
            window.submit(index, start, result);
        }
    }
}

#[derive(Default)]
struct WindowState {
    next_claim: u64,
    next_write: u64,
    ready: BTreeMap<u64, ChunkResult>,
    aborted: bool,
}

struct Window {
    state: Mutex<WindowState>,
    slot_available: Condvar,
    chunk_ready: Condvar,
    // The start of the earliest failed chunk. Earlier workers can still
    // complete so the coordinator observes the first run error in run order.
    stop_at: AtomicU64,
}

impl Default for Window {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            slot_available: Condvar::new(),
            chunk_ready: Condvar::new(),
            stop_at: AtomicU64::new(NO_FAILURE),
        }
    }
}

impl Window {
    fn claim(&self, batch: &Batch<'_>) -> Option<u64> {
        let mut state = self.state.lock().unwrap();
        loop {
            if batch.cancel.is_cancelled()
                || self.stop_at.load(Ordering::Relaxed) != NO_FAILURE
                || state.next_claim == batch.chunks
            {
                return None;
            }
            if state.next_claim - state.next_write < batch.window_size {
                let index = state.next_claim;
                state.next_claim += 1;
                return Some(index);
            }
            state = self.slot_available.wait(state).unwrap();
        }
    }

    fn submit(&self, index: u64, start: u64, result: ChunkResult) {
        let mut state = self.state.lock().unwrap();
        if state.aborted || start > self.stop_at.load(Ordering::Relaxed) {
            return;
        }
        if result.is_err() {
            self.stop_at.store(start, Ordering::Relaxed);
            self.slot_available.notify_all();
        }
        state.ready.insert(index, result);
        self.chunk_ready.notify_one();
    }

    fn take(&self, index: u64, cancel: &CancelToken) -> ChunkResult {
        let mut state = self.state.lock().unwrap();
        loop {
            check_cancelled(cancel)?;
            if state.aborted {
                return Err(SimulationError::Cancelled);
            }
            if let Some(result) = state.ready.remove(&index) {
                return result;
            }
            // CancelToken is shared with callers and does not notify this window.
            state = self
                .chunk_ready
                .wait_timeout(state, CANCEL_POLL_INTERVAL)
                .unwrap()
                .0;
        }
    }

    fn written(&self, index: u64) {
        self.state.lock().unwrap().next_write = index + 1;
        self.slot_available.notify_one();
    }

    fn abort(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.aborted = true;
        self.stop_at.store(0, Ordering::Relaxed);
        self.slot_available.notify_all();
        self.chunk_ready.notify_one();
    }
}

struct AbortOnExit<'a>(&'a Window);

impl Drop for AbortOnExit<'_> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::{sync::mpsc, time::Instant};

    use gachasimulate_types::fixtures::deterministic_program;

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    fn options() -> SimulationOptions {
        SimulationOptions {
            total_runs: 20,
            seed: 0,
            threads: 8,
            chunk_size: Some(1),
            max_in_flight_chunks: Some(3),
        }
    }

    #[test]
    fn default_chunk_size_uses_the_run_count_and_requested_threads() {
        let program = deterministic_program();
        let cancel = CancelToken::new();
        for (total_runs, threads, chunk_size, workers) in [
            (100, 1, 100, 1),
            (10_000, 16, 313, 16),
            (1_000_000, 1, 16_384, 1),
            (1_000_000, 16, 16_384, 16),
        ] {
            let options = SimulationOptions {
                total_runs,
                threads,
                chunk_size: None,
                max_in_flight_chunks: None,
                ..options()
            };
            let batch = Batch::new(&program, &options, &cancel).unwrap();
            assert_eq!(batch.chunk_size, chunk_size);
            assert_eq!(batch.workers, workers);
        }
    }

    #[test]
    fn window_counts_computing_buffered_and_currently_writing_chunks() {
        #[derive(Debug, PartialEq, Eq)]
        enum Event {
            Claimed(u64),
            WritingFirst,
        }

        let program = deterministic_program();
        let options = SimulationOptions {
            total_runs: 100,
            threads: 16,
            chunk_size: None,
            ..options()
        };
        let cancel = CancelToken::new();
        let batch = Batch::new(&program, &options, &cancel).unwrap();
        assert_eq!(batch.chunk_size, 4);
        assert_eq!(batch.workers, 3);
        let (event, events) = mpsc::channel();
        let (release_first, first_gate) = mpsc::channel();
        let (release_write, write_gate) = mpsc::channel();
        let first_gate = Mutex::new(first_gate);
        let mut written = Vec::new();

        thread::scope(|scope| {
            let written = &mut written;
            let scheduler = scope.spawn(move || {
                batch.run_parallel(
                    |chunk| {
                        if chunk.start_run == 0 {
                            event.send(Event::WritingFirst).unwrap();
                            write_gate.recv_timeout(TIMEOUT).unwrap();
                        }
                        written.push(chunk.start_run);
                        Ok(())
                    },
                    |start, scratch, control| {
                        event.send(Event::Claimed(start)).unwrap();
                        if start == 0 {
                            first_gate.lock().unwrap().recv_timeout(TIMEOUT).unwrap();
                        }
                        batch.compute_chunk(start, scratch, control)
                    },
                )
            });

            let mut claims = [0; 3];
            for claim in &mut claims {
                let Event::Claimed(index) = events.recv_timeout(TIMEOUT).unwrap() else {
                    panic!("the first chunk is still blocked");
                };
                *claim = index;
            }
            claims.sort_unstable();
            assert_eq!(claims, [0, 4, 8]);
            let blocked_wait = Duration::from_millis(100);
            assert_eq!(
                events.recv_timeout(blocked_wait),
                Err(mpsc::RecvTimeoutError::Timeout)
            );

            release_first.send(()).unwrap();
            assert_eq!(events.recv_timeout(TIMEOUT).unwrap(), Event::WritingFirst);
            assert_eq!(
                events.recv_timeout(blocked_wait),
                Err(mpsc::RecvTimeoutError::Timeout)
            );

            release_write.send(()).unwrap();
            scheduler.join().unwrap().unwrap();
        });

        assert_eq!(
            written,
            (0..options.total_runs).step_by(4).collect::<Vec<_>>()
        );
    }

    #[test]
    fn an_error_stops_new_claims_but_an_earlier_error_wins() {
        let program = deterministic_program();
        let options = options();
        let cancel = CancelToken::new();
        let batch = Batch::new(&program, &options, &cancel).unwrap();
        let error = batch
            .run_parallel(
                |_| panic!("no chunks precede the first error"),
                |start, scratch, control| match start {
                    0 => {
                        let cutoff = control.stop_at.unwrap();
                        let deadline = Instant::now() + TIMEOUT;
                        while cutoff.load(Ordering::Relaxed) != 1 {
                            assert!(Instant::now() < deadline, "later failure was not published");
                            thread::yield_now();
                        }
                        Err(SimulationError::StepLimitExceeded { run_index: 0 })
                    }
                    1 => Err(SimulationError::StepLimitExceeded { run_index: 1 }),
                    2 => batch.compute_chunk(start, scratch, control),
                    _ => panic!("new claims passed the failed window"),
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            SimulationError::StepLimitExceeded { run_index: 0 }
        ));
    }

    #[test]
    fn cancellation_wakes_coordinator_waiting_for_the_first_chunk() {
        let program = deterministic_program();
        let options = options();
        let cancel = CancelToken::new();
        let batch = Batch::new(&program, &options, &cancel).unwrap();
        let (started, ready_to_cancel) = mpsc::channel();
        let (finished, result) = mpsc::channel();

        thread::scope(|scope| {
            scope.spawn(|| {
                let result = batch.run_parallel(
                    |_| panic!("first chunk was cancelled"),
                    |start, scratch, control| {
                        if start != 0 {
                            return batch.compute_chunk(start, scratch, control);
                        }
                        started.send(()).unwrap();
                        let deadline = Instant::now() + TIMEOUT;
                        while !control.cancel.is_cancelled() {
                            assert!(Instant::now() < deadline, "cancellation did not arrive");
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(SimulationError::Cancelled)
                    },
                );
                finished.send(result).unwrap();
            });
            ready_to_cancel.recv_timeout(TIMEOUT).unwrap();
            cancel.cancel();
            assert!(matches!(
                result.recv_timeout(TIMEOUT).unwrap(),
                Err(SimulationError::Cancelled)
            ));
        });
    }

    #[test]
    fn rejects_oversized_thread_requests_before_spawning_workers() {
        let program = deterministic_program();
        let cancel = CancelToken::new();
        for threads in [0, MAX_THREADS + 1, usize::MAX] {
            let options = SimulationOptions {
                total_runs: 100_000,
                seed: 0,
                threads,
                chunk_size: None,
                max_in_flight_chunks: None,
            };
            assert!(matches!(
                Batch::new(&program, &options, &cancel),
                Err(SimulationError::InvalidOptions { .. })
            ));
        }
    }
}
