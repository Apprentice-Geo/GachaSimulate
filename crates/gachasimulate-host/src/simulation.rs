use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ExitStatus, Stdio},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use gachasimulate_desktop_contract::{
    CancelSimulationRequest, ConfigSnapshotProvider, ConfigSource, DesktopError, DesktopErrorCode,
    SimulationCommandRequest, SimulationStage, SimulationStatus, SimulationTaskEvent,
    SimulationTaskSnapshot, SimulationTaskStateMachine, WorkerSimulationEvent, WorkerSimulationJob,
    WorkerSimulationOptions,
};
use gachasimulate_gsr::GsrReader;
use gachasimulate_types::{MAX_CHUNK_RECORDS, MAX_GSR_FILE_BYTES};
use sha2::{Digest, Sha256};

use crate::{
    desktop_error,
    files::{remove_if_present, unique_id, ResultFiles},
    logical_cpu_count,
    transport::{
        bounded_json, read_line, read_stderr, worker_command, EVENT_LIMIT, JOB_LIMIT, PROCESS_POLL,
    },
    HostConfig,
};

#[derive(Clone)]
pub struct SimulationHost {
    inner: Arc<SimulationInner>,
}

struct SimulationInner {
    config: Arc<HostConfig>,
    provider: Arc<dyn ConfigSnapshotProvider>,
    files: Arc<Mutex<ResultFiles>>,
    state: Mutex<HostState>,
    changed: Condvar,
    events: Sender<SimulationTaskEvent>,
}

#[derive(Default)]
struct HostState {
    task: SimulationTaskStateMachine,
    last_completed: Option<PathBuf>,
    stopping: bool,
}

impl SimulationHost {
    pub(crate) fn new(
        config: Arc<HostConfig>,
        provider: Arc<dyn ConfigSnapshotProvider>,
        files: Arc<Mutex<ResultFiles>>,
    ) -> io::Result<Self> {
        let (events, receiver) = mpsc::channel();
        let sink = config.event_sink.clone();
        thread::Builder::new()
            .name("simulation-events".into())
            .spawn(move || {
                for event in receiver {
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(event)));
                }
            })?;
        Ok(Self {
            inner: Arc::new(SimulationInner {
                config,
                provider,
                files,
                state: Mutex::default(),
                changed: Condvar::new(),
                events,
            }),
        })
    }

    pub fn get_simulation_state(&self) -> Result<SimulationTaskSnapshot, DesktopError> {
        Ok(self.inner.state.lock().unwrap().task.snapshot().clone())
    }

    pub fn last_completed_result_path(&self) -> Option<PathBuf> {
        self.inner.state.lock().unwrap().last_completed.clone()
    }

    /// Reserves the slot before resolving the snapshot on the coordinator.
    pub fn start_simulation(
        &self,
        request: SimulationCommandRequest,
    ) -> Result<SimulationTaskSnapshot, DesktopError> {
        request.validate(logical_cpu_count())?;
        let mut state = self.inner.state.lock().unwrap();
        if state.stopping {
            return Err(DesktopError::new(
                DesktopErrorCode::Conflict,
                "Desktop host is shutting down",
            ));
        }
        let id = state.task.snapshot().task_id.unwrap_or(0) + 1;
        let event = state.task.start(id, request.total_runs)?;
        let accepted = event.snapshot.clone();
        self.inner.record(event);

        let inner = self.inner.clone();
        if let Err(error) = thread::Builder::new()
            .name(format!("simulation-{id}"))
            .spawn(move || inner.coordinate(id, &request))
        {
            let event = state.task.fail(
                id,
                format!("Could not start simulation coordinator: {error}"),
            );
            self.inner.record_optional(event);
        }
        Ok(accepted)
    }

    /// Returns once acceptance is recorded. The coordinator owns termination
    /// and cleanup, including retries with the same child and temporary path.
    pub fn cancel_simulation(
        &self,
        request: CancelSimulationRequest,
    ) -> Result<SimulationTaskSnapshot, DesktopError> {
        request.validate()?;
        let mut state = self.inner.state.lock().unwrap();
        let event = state.task.request_cancel(request.task_id)?;
        let accepted = event.snapshot.clone();
        self.inner.record(event);
        Ok(accepted)
    }

    pub(crate) fn begin_shutdown(&self) {
        let mut state = self.inner.state.lock().unwrap();
        state.stopping = true;
        if let Some(id) = state.task.snapshot().task_id {
            if let Ok(event) = state.task.request_cancel(id) {
                self.inner.record(event);
            }
        }
    }

    pub(crate) fn finish_shutdown(&self) -> Result<(), DesktopError> {
        let budget = self.config_shutdown_budget();
        let deadline = Instant::now() + budget;
        let mut state = self.inner.state.lock().unwrap();
        loop {
            let snapshot = state.task.snapshot();
            let waiting = matches!(
                snapshot.status,
                SimulationStatus::Starting
                    | SimulationStatus::Running
                    | SimulationStatus::Saving
                    | SimulationStatus::Cancelling
            ) && !snapshot.cancel_retryable;
            if !waiting {
                break;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                if let Some(id) = snapshot.task_id {
                    let event = state.task.cancel_retryable(
                        id,
                        "Timed out waiting for simulation cancellation".into(),
                    );
                    self.inner.record_optional(event);
                }
                break;
            }
            let (guard, timeout) = self.inner.changed.wait_timeout(state, remaining).unwrap();
            state = guard;
            if timeout.timed_out() {
                let snapshot = state.task.snapshot();
                let still_waiting = matches!(
                    snapshot.status,
                    SimulationStatus::Starting
                        | SimulationStatus::Running
                        | SimulationStatus::Saving
                        | SimulationStatus::Cancelling
                ) && !snapshot.cancel_retryable;
                if still_waiting {
                    if let Some(id) = snapshot.task_id {
                        let event = state.task.cancel_retryable(
                            id,
                            "Timed out waiting for simulation cancellation".into(),
                        );
                        self.inner.record_optional(event);
                    }
                    break;
                }
            }
        }
        let snapshot = state.task.snapshot();
        if snapshot.cancel_retryable {
            return Err(DesktopError::new(
                DesktopErrorCode::CleanupBlocked,
                snapshot
                    .message
                    .as_deref()
                    .unwrap_or("Simulation cleanup failed"),
            ));
        }
        Ok(())
    }

    fn config_shutdown_budget(&self) -> Duration {
        self.inner
            .config
            .cooperative_cancel_timeout
            .saturating_add(self.inner.config.force_kill_timeout)
            .saturating_add(Duration::from_millis(250))
    }

    pub(crate) fn resume_after_shutdown_error(&self) {
        self.inner.state.lock().unwrap().stopping = false;
    }
}

impl SimulationInner {
    // Called with the state mutex held to enqueue events in sequence order.
    fn record(&self, event: SimulationTaskEvent) {
        let _ = self.events.send(event);
        self.changed.notify_all();
    }

    fn record_optional(&self, event: Option<SimulationTaskEvent>) {
        if let Some(event) = event {
            self.record(event);
        }
    }

    fn is_cancelling(&self) -> bool {
        self.state.lock().unwrap().task.snapshot().status == SimulationStatus::Cancelling
    }

    fn coordinate(&self, id: u64, request: &SimulationCommandRequest) {
        let mut temp = None;
        let final_path = self.config.results_dir.join(result_filename(request));
        let mut protocol = WorkerProtocol::default();
        let mut worker = match self.prepare_worker(request, &mut temp) {
            Ok(worker) => worker,
            Err(error) => {
                protocol.failure = Some(error.to_string());
                None
            }
        };
        loop {
            let mut blocked = None;
            if let Some(process) = &mut worker {
                match process.wait(self, id, &mut protocol) {
                    Ok(()) => worker = None,
                    Err(error) => blocked = Some(error),
                }
            }
            if protocol.failure.is_none() && blocked.is_none() && !self.is_cancelling() {
                protocol.failure = match (temp.as_deref(), protocol.completion.as_ref()) {
                    (Some(path), Some(completion)) => verify_output(path, request, completion)
                        .err()
                        .map(|error| format!("Invalid simulation output: {error}")),
                    _ => Some("Simulation worker did not report completion".into()),
                };
            }

            let mut files = (blocked.is_none()
                && protocol.failure.is_none()
                && protocol.completion.is_some()
                && !self.is_cancelling())
            .then(|| self.files.lock().unwrap());
            let mut state = self.state.lock().unwrap();
            let cancelling = state.task.snapshot().status == SimulationStatus::Cancelling;
            if let Some(files) = files.as_deref_mut().filter(|_| !cancelling) {
                match self.commit(
                    &mut state,
                    files,
                    id,
                    &final_path,
                    temp.as_deref().unwrap(),
                    protocol.completion.take().unwrap(),
                ) {
                    Ok(()) => {
                        return;
                    }
                    Err(error) => protocol.failure = Some(error.to_string()),
                }
            }
            drop(files);

            if blocked.is_none() {
                if let Some(path) = &temp {
                    blocked = remove_if_present(path).err().map(|error| {
                        format!("Could not remove temporary GSR {}: {error}", path.display())
                    });
                }
            }
            if let Some(cleanup) = blocked {
                let event = if cancelling {
                    state.task.cancel_retryable(id, cleanup)
                } else {
                    let failure = protocol
                        .failure
                        .get_or_insert_with(|| "Simulation worker failed".into());
                    state
                        .task
                        .fail_cleanup_retryable(id, failure.clone(), cleanup)
                };
                self.record_optional(event);
                drop(
                    self.changed
                        .wait_while(state, |state| state.task.snapshot().cancel_retryable)
                        .unwrap(),
                );
            } else {
                let event = if cancelling {
                    state.task.finish_cleanup(id)
                } else {
                    state.task.fail(id, protocol.failure.take().unwrap())
                };
                self.record_optional(event);
                return;
            }
        }
    }

    fn prepare_worker(
        &self,
        request: &SimulationCommandRequest,
        temp: &mut Option<PathBuf>,
    ) -> Result<Option<SimulationProcess>, DesktopError> {
        if self.is_cancelling() {
            return Ok(None);
        }
        let resolved = self
            .provider
            .resolve_snapshot(request.config_source, &request.config_id)?;
        if resolved.source != request.config_source || resolved.config_id != request.config_id {
            return Err(DesktopError::new(
                DesktopErrorCode::Internal,
                "Snapshot provider returned a different configuration",
            ));
        }
        if self.is_cancelling() {
            return Ok(None);
        }

        let io_error = |error| desktop_error(DesktopErrorCode::Io, error);
        fs::create_dir_all(&self.config.results_dir).map_err(io_error)?;
        let path = self
            .config
            .results_dir
            .join(format!(".tmp-{}.gsr", unique_id().map_err(io_error)?));
        let path_text = path
            .to_str()
            .ok_or_else(|| {
                DesktopError::new(
                    DesktopErrorCode::Io,
                    "Temporary output path is not valid UTF-8",
                )
            })?
            .to_owned();
        let mut job = bounded_json(
            &WorkerSimulationJob {
                snapshot: resolved.snapshot,
                termination_file: request.termination.clone(),
                result_item: request.result_item.clone(),
                options: WorkerSimulationOptions {
                    total_runs: request.total_runs,
                    seed: request.seed,
                    threads: request.threads,
                    chunk_size: None,
                    max_in_flight_chunks: None,
                },
                temp_output_path: path_text,
            },
            JOB_LIMIT,
        )
        .map_err(|error| desktop_error(DesktopErrorCode::Simulation, error))?;
        job.push(b'\n');
        // Hold the host state lock across the final cancellation check and
        // worker spawn so cancellation/shutdown cannot land between them.
        let state = self.state.lock().unwrap();
        if state.stopping || state.task.snapshot().status == SimulationStatus::Cancelling {
            return Ok(None);
        }
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io_error)?;
        *temp = Some(path);
        SimulationProcess::start(&self.config.worker_binary_path, job)
            .map(Some)
            .map_err(io_error)
    }

    fn commit(
        &self,
        state: &mut HostState,
        files: &mut ResultFiles,
        id: u64,
        final_path: &Path,
        temp: &Path,
        completion: Completion,
    ) -> io::Result<()> {
        let filename = final_path.file_name().unwrap().to_str().unwrap();
        if !state.task.can_commit(
            id,
            completion.total_runs,
            &completion.total_result,
            filename,
        ) {
            return Err(io::Error::other(
                "Simulation completion cannot be committed",
            ));
        }
        files.replace_gsr(temp, final_path)?;
        let event = state
            .task
            .complete(
                id,
                completion.total_runs,
                completion.total_result,
                filename.to_owned(),
            )
            .expect("completion was checked under the same lock");
        state.last_completed = Some(final_path.to_owned());
        self.record(event);
        Ok(())
    }

    fn update_task(
        &self,
        update: impl FnOnce(&mut SimulationTaskStateMachine) -> Option<SimulationTaskEvent>,
    ) {
        let mut state = self.state.lock().unwrap();
        let event = update(&mut state.task);
        self.record_optional(event);
    }
}

struct Completion {
    total_runs: u64,
    total_result: String,
    chunks_written: u64,
    file_size: u64,
}

#[derive(Default)]
struct WorkerProtocol {
    started: bool,
    stage: Option<SimulationStage>,
    progress: u64,
    completion: Option<Completion>,
    failure: Option<String>,
}

impl WorkerProtocol {
    fn accept(
        &mut self,
        host: &SimulationInner,
        id: u64,
        total: u64,
        event: WorkerSimulationEvent,
    ) {
        if self.failure.is_some() || host.is_cancelling() {
            return;
        }
        match event {
            WorkerSimulationEvent::Started if !self.started => self.started = true,
            WorkerSimulationEvent::Stage { stage }
                if self.started
                    && matches!(
                        (self.stage, stage),
                        (None, SimulationStage::Simulating)
                            | (Some(SimulationStage::Simulating), SimulationStage::Saving)
                    ) =>
            {
                self.stage = Some(stage);
                host.update_task(|task| task.set_stage(id, stage));
            }
            WorkerSimulationEvent::Progress {
                completed_runs,
                total_runs,
            } if self.stage == Some(SimulationStage::Simulating)
                && total_runs == total
                && completed_runs > self.progress
                && completed_runs <= total =>
            {
                self.progress = completed_runs;
                host.update_task(|task| task.progress(id, completed_runs, total_runs));
            }
            WorkerSimulationEvent::Completed {
                total_runs,
                total_result,
                chunks_written,
                file_size,
            } if self.stage == Some(SimulationStage::Saving) && self.completion.is_none() => {
                self.completion = Some(Completion {
                    total_runs,
                    total_result,
                    chunks_written,
                    file_size,
                });
            }
            WorkerSimulationEvent::Error { message } if self.completion.is_none() => {
                self.failure = Some(message);
            }
            _ => {
                self.failure = Some("Simulation worker sent an unexpected event".into());
            }
        }
    }
}

struct SimulationProcess {
    child: Child,
    input: Option<Sender<()>>,
    input_thread: Option<JoinHandle<io::Result<()>>>,
    events: Receiver<Result<WorkerSimulationEvent, String>>,
    stderr: Option<JoinHandle<String>>,
}

impl SimulationProcess {
    fn start(binary: &Path, job: Vec<u8>) -> io::Result<Self> {
        let mut child = worker_command(binary)
            .arg("simulate")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (input, signals) = mpsc::channel();
        let input_thread = thread::spawn(move || {
            stdin.write_all(&job)?;
            drop(job);
            if signals.recv().is_ok() {
                let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n");
            }
            Ok(())
        });
        let (lines, events) = mpsc::sync_channel(16);
        thread::spawn(move || {
            let mut stdout = BufReader::new(stdout);
            loop {
                let event = match read_line(&mut stdout, EVENT_LIMIT) {
                    Ok(Some(line)) => {
                        serde_json::from_slice(&line).map_err(|error| error.to_string())
                    }
                    Ok(None) => break,
                    Err(error) => Err(error.to_string()),
                };
                let failed = event.is_err();
                if lines.send(event).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            input_thread: Some(input_thread),
            events,
            stderr: Some(thread::spawn(move || read_stderr(stderr))),
        })
    }

    fn wait(
        &mut self,
        host: &SimulationInner,
        id: u64,
        protocol: &mut WorkerProtocol,
    ) -> Result<(), String> {
        let total = host.state.lock().unwrap().task.snapshot().total_runs;
        let mut exited = None;
        let mut eof = false;
        let mut stop = None::<Instant>;
        let mut killed = None::<Instant>;
        loop {
            if exited.is_none() {
                match self.child.try_wait() {
                    Ok(status) => exited = status,
                    Err(error) => {
                        protocol.failure.get_or_insert_with(|| {
                            format!("Could not wait for simulation worker: {error}")
                        });
                    }
                }
            }
            if exited.is_some() {
                self.input.take();
                if eof {
                    break;
                }
                // Drain remaining events even after exit so completion is never
                // inferred from the exit code alone.
                self.read_event(host, id, total, protocol, &mut eof);
                continue;
            }

            if eof && protocol.completion.is_none() {
                protocol.failure.get_or_insert_with(|| {
                    "Simulation worker closed stdout before reporting completion".into()
                });
            }
            if host.is_cancelling() || protocol.failure.is_some() {
                let now = Instant::now();
                let requested = stop.get_or_insert(now);
                if let Some(input) = self.input.take() {
                    let _ = input.send(());
                }
                if let Some(killed) = killed {
                    if killed.elapsed() >= host.config.force_kill_timeout {
                        return Err("Simulation worker did not exit after force kill".into());
                    }
                } else if requested.elapsed() >= host.config.cooperative_cancel_timeout {
                    if let Err(error) = (host.config.worker_killer)(&mut self.child) {
                        if self.child.try_wait().ok().flatten().is_none() {
                            return Err(format!("Could not force-kill simulation worker: {error}"));
                        }
                    }
                    killed = Some(now);
                }
            }
            if eof {
                thread::sleep(PROCESS_POLL);
            } else {
                self.read_event(host, id, total, protocol, &mut eof);
            }
        }

        // The process has released its pipes. Take ownership of the joins while
        // allowing this process object to stay in place during blocked retries.
        self.finish(exited.unwrap(), protocol);
        Ok(())
    }

    fn read_event(
        &self,
        host: &SimulationInner,
        id: u64,
        total: u64,
        protocol: &mut WorkerProtocol,
        eof: &mut bool,
    ) {
        match self.events.recv_timeout(PROCESS_POLL) {
            Ok(Ok(event)) => protocol.accept(host, id, total, event),
            Ok(Err(error)) => {
                protocol
                    .failure
                    .get_or_insert_with(|| format!("Invalid simulation worker event: {error}"));
            }
            Err(RecvTimeoutError::Disconnected) => *eof = true,
            Err(RecvTimeoutError::Timeout) => (),
        }
    }

    fn finish(&mut self, status: ExitStatus, protocol: &mut WorkerProtocol) {
        let input = self.input_thread.take().unwrap().join();
        let stderr = self.stderr.take().unwrap().join().unwrap_or_default();
        if protocol.failure.is_some() {
            return;
        }
        if !status.success() {
            protocol.failure = Some(if stderr.is_empty() {
                format!("Simulation worker exited with {status}")
            } else {
                stderr
            });
        } else if let Err(error) =
            input.unwrap_or_else(|_| Err(io::Error::other("Simulation input thread failed")))
        {
            protocol.failure = Some(format!("Could not send simulation job: {error}"));
        }
    }
}

fn verify_output(
    path: &Path,
    request: &SimulationCommandRequest,
    completion: &Completion,
) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.len() != completion.file_size
        || completion.file_size > MAX_GSR_FILE_BYTES
        || completion.total_runs != request.total_runs
        || !(request.total_runs.div_ceil(MAX_CHUNK_RECORDS as u64)..=request.total_runs)
            .contains(&completion.chunks_written)
    {
        return Err(io::Error::other(
            "Temporary GSR file does not match completion metadata",
        ));
    }
    let expected_total_result = completion
        .total_result
        .parse::<u64>()
        .map_err(io::Error::other)?;
    let mut file = BufReader::new(File::open(path)?);
    let mut reader = GsrReader::new(&mut file).map_err(io::Error::other)?;
    let header = reader.metadata();
    if header.total_runs != completion.total_runs
        || header.seed != request.seed
        || header.result_item_id != request.result_item
    {
        return Err(io::Error::other(
            "Temporary GSR header does not match the job",
        ));
    }
    let mut chunks = 0u64;
    let mut total_result = 0u64;
    while let Some(chunk) = reader.next_chunk().map_err(io::Error::other)? {
        chunks += 1;
        for record in &chunk.records {
            total_result = total_result
                .checked_add(record.value)
                .ok_or_else(|| io::Error::other("Temporary GSR total result overflow"))?;
        }
    }
    if chunks != completion.chunks_written || total_result != expected_total_result {
        return Err(io::Error::other(
            "Temporary GSR trailer does not match completion metadata",
        ));
    }
    Ok(())
}

fn result_filename(request: &SimulationCommandRequest) -> String {
    const STEM_LIMIT: usize = 255 - ".visualize.json".len();
    let source = match request.config_source {
        ConfigSource::Installed => "installed",
        ConfigSource::Local => "local",
    };
    let termination = &request.termination;
    let term_stem = termination
        .rsplit_once('.')
        .filter(|(_, ext)| ext.eq_ignore_ascii_case("yaml"))
        .map_or(termination.as_str(), |(stem, _)| stem);
    // Match the existing desktop naming rule, which replaces each unsafe UTF-16 unit.
    let sanitized: String = term_stem
        .encode_utf16()
        .map(|unit| {
            let byte = u8::try_from(unit).unwrap_or(b'_');
            if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-') {
                char::from(byte)
            } else {
                '_'
            }
        })
        .collect();
    let mut readable = format!(
        "{source}-{}-{sanitized}-{}",
        request.config_id, request.result_item
    );
    let mut hash = Sha256::new();
    hash.update(source);
    for component in [&request.config_id, termination, &request.result_item] {
        hash.update(b"\0");
        hash.update(component);
    }
    let digest = hash.finalize();
    let short: String = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let suffix = format!(
        "-{short}-runs{}-seed{}-threads{}",
        request.total_runs, request.seed, request.threads
    );
    readable.truncate(readable.len().min(STEM_LIMIT - suffix.len()));
    format!("{readable}{suffix}.gsr")
}
