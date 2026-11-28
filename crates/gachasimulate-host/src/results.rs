use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, TryRecvError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Instant, SystemTime},
};

use gachasimulate_desktop_contract::{
    Analysis, ConfirmResultSessionRequest, ConfirmResultSessionResponse, DesktopError,
    DesktopErrorCode, DiscardResultDraftRequest, DisplayConfig, ResultCandidateSession,
    SaveResultFieldsRequest, SavedResultFields, DISPLAY_CONFIG_JSON_BYTE_LIMIT,
};
use gachasimulate_types::{CancelToken, MAX_ANALYSIS_JSON_BYTES};

use crate::{
    desktop_error,
    files::{remove_if_present, save_temp_path, sidecar_path, unique_id, ResultFiles},
    transport::{read_bounded, read_line, read_stderr, worker_command, PROCESS_POLL},
    HostConfig, SimulationHost,
};

pub struct ResultSessionHost {
    config: Arc<HostConfig>,
    simulation: SimulationHost,
    files: Arc<Mutex<ResultFiles>>,
    state: Mutex<ResultState>,
    analyzer: Mutex<Option<AnalyzerProcess>>,
    saves: Mutex<()>,
}

#[derive(Default)]
struct ResultState {
    pending: Option<Session>,
    active: Option<Session>,
    save_error: Option<DesktopError>,
    opening: Option<CancelToken>,
    stopping: bool,
}

#[derive(Clone, PartialEq, Eq)]
struct GsrIdentity {
    len: u64,
    modified: Option<SystemTime>,
    header: [u8; 48],
    trailer: [u8; 24],
}

fn read_gsr_identity(path: &Path) -> io::Result<GsrIdentity> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() < 48 + 24 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "GSR file is missing or truncated",
        ));
    }
    let mut header = [0u8; 48];
    file.read_exact(&mut header)?;
    file.seek(SeekFrom::End(-24))?;
    let mut trailer = [0u8; 24];
    file.read_exact(&mut trailer)?;
    Ok(GsrIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        header,
        trailer,
    })
}

struct Session {
    id: String,
    gsr_path: PathBuf,
    gsr_identity: GsrIdentity,
    sidecar: PathBuf,
    display: DisplayConfig,
    revision: Arc<AtomicBool>,
}

impl ResultSessionHost {
    pub(crate) fn new(
        config: Arc<HostConfig>,
        simulation: SimulationHost,
        files: Arc<Mutex<ResultFiles>>,
    ) -> Self {
        Self {
            config,
            simulation,
            files,
            state: Mutex::default(),
            analyzer: Mutex::default(),
            saves: Mutex::default(),
        }
    }

    /// Accepts the path returned by the shell's file picker.
    pub fn select_gsr_result(
        &self,
        path: Option<&Path>,
    ) -> Result<Option<ResultCandidateSession>, DesktopError> {
        path.map(|path| self.open_gsr_path(path)).transpose()
    }

    pub fn open_simulation_result(&self) -> Result<ResultCandidateSession, DesktopError> {
        let path = self
            .simulation
            .last_completed_result_path()
            .ok_or_else(|| {
                DesktopError::new(
                    DesktopErrorCode::NotFound,
                    "No simulation result has been committed",
                )
            })?;
        self.open_gsr_path(&path)
    }

    /// Runs the analyzer synchronously for the caller. Shell commands can run
    /// this on their blocking pool. New requests cancel any previous open.
    pub fn open_gsr_path(&self, path: &Path) -> Result<ResultCandidateSession, DesktopError> {
        if !path.is_absolute()
            || !path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("gsr"))
        {
            return Err(DesktopError::new(
                DesktopErrorCode::InvalidRequest,
                "Expected an absolute .gsr file path",
            ));
        }
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| {
                DesktopError::new(DesktopErrorCode::InvalidRequest, "Invalid GSR filename")
            })?;
        let cancel = CancelToken::new();
        {
            let mut state = self.state.lock().unwrap();
            require_running(&state)?;
            if let Some(previous) = state.opening.replace(cancel.clone()) {
                previous.cancel();
            }
            state.pending = None;
        }

        let mut analyzer = self.analyzer.lock().unwrap();
        check_open(&cancel)?;
        self.stop_analyzer(&mut analyzer)?;
        let (revision, gsr_identity) = {
            let mut files = self.files.lock().unwrap();
            let resolved = fs::canonicalize(path).map_err(|error| {
                let code = if error.kind() == io::ErrorKind::NotFound {
                    DesktopErrorCode::NotFound
                } else {
                    DesktopErrorCode::Io
                };
                desktop_error(code, error)
            })?;
            let identity = read_gsr_identity(path)
                .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?;
            (files.revision(&resolved), identity)
        };
        let analysis = self.analyze(path, &cancel, &mut analyzer)?;
        check_open(&cancel)?;
        let identity_after = read_gsr_identity(path)
            .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?;
        if identity_after != gsr_identity {
            return Err(DesktopError::new(
                DesktopErrorCode::Conflict,
                "GSR file changed while analyzing",
            ));
        }

        let sidecar = sidecar_path(path);
        let display = {
            let _files = self.files.lock().unwrap();
            check_revision(&revision)?;
            read_sidecar(&sidecar)?
                .unwrap_or_else(|| DisplayConfig::for_missing_sidecar(&analysis.result_item.name))
        };
        let candidate = ResultCandidateSession {
            session_id: unique_id()
                .map_err(|error| desktop_error(DesktopErrorCode::Internal, error))?,
            filename: filename.to_owned(),
            fields: display.fields(),
            analysis,
            display,
        };
        candidate.validate()?;

        let mut state = self.state.lock().unwrap();
        let _files = self.files.lock().unwrap();
        check_open(&cancel)?;
        check_revision(&revision)?;
        state.pending = Some(Session {
            id: candidate.session_id.clone(),
            gsr_path: path.to_path_buf(),
            gsr_identity,
            sidecar,
            display: candidate.display.clone(),
            revision,
        });
        state.opening = None;
        Ok(candidate)
    }

    pub fn confirm_result_session(
        &self,
        request: ConfirmResultSessionRequest,
    ) -> Result<ConfirmResultSessionResponse, DesktopError> {
        let mut state = self.state.lock().unwrap();
        require_running(&state)?;
        let _files = self.files.lock().unwrap();
        let confirmed = state.pending.as_ref().is_some_and(|session| {
            session.id == request.session_id && session.revision.load(Ordering::Relaxed)
        });
        if confirmed {
            state.active = state.pending.take();
            state.save_error = None;
        }
        Ok(ConfirmResultSessionResponse {
            confirmed,
            active_session_id: state.active.as_ref().map(|session| session.id.clone()),
        })
    }

    pub fn save_result_fields(
        &self,
        request: SaveResultFieldsRequest,
    ) -> Result<SavedResultFields, DesktopError> {
        let _save = self.saves.lock().unwrap();
        let (gsr_path, gsr_identity, sidecar, revision) = {
            let state = self.state.lock().unwrap();
            let active = require_session(&state, &request.session_id)?;
            (
                active.gsr_path.clone(),
                active.gsr_identity.clone(),
                active.sidecar.clone(),
                active.revision.clone(),
            )
        };
        let display = DisplayConfig::from_fields(request.fields);
        let prepared = check_revision(&revision).and_then(|()| prepare_sidecar(&sidecar, &display));

        let mut state = self.state.lock().unwrap();
        require_session(&state, &request.session_id)?;
        let _files = self.files.lock().unwrap();
        let outcome = prepared.and_then(|mut temp| {
            check_revision(&revision)?;
            let current_identity = read_gsr_identity(&gsr_path).map_err(|_| {
                DesktopError::new(
                    DesktopErrorCode::Conflict,
                    "GSR file is no longer available or changed after opening",
                )
            })?;
            if current_identity != gsr_identity {
                return Err(DesktopError::new(
                    DesktopErrorCode::Conflict,
                    "GSR file changed after opening",
                ));
            }
            // Refuse to overwrite an invalid sidecar added after this session opened.
            read_sidecar(&sidecar)?;
            fs::rename(&temp.0, &sidecar)
                .map_err(|error| desktop_error(DesktopErrorCode::Sidecar, error))?;
            temp.0.clear();
            Ok(())
        });
        match outcome {
            Ok(()) => {
                state.active.as_mut().unwrap().display = display.clone();
                if state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.sidecar == sidecar)
                {
                    state.pending = None;
                }
                state.save_error = None;
                Ok(SavedResultFields {
                    session_id: request.session_id,
                    display,
                })
            }
            Err(error) => {
                state.save_error = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn discard_result_draft(
        &self,
        request: DiscardResultDraftRequest,
    ) -> Result<(), DesktopError> {
        let _save = self.saves.lock().unwrap();
        let mut state = self.state.lock().unwrap();
        require_session(&state, &request.session_id)?;
        state.save_error = None;
        Ok(())
    }

    pub(crate) fn begin_shutdown(&self) {
        let mut state = self.state.lock().unwrap();
        state.stopping = true;
        if let Some(cancel) = state.opening.take() {
            cancel.cancel();
        }
    }

    pub(crate) fn finish_shutdown(&self) -> Result<(), DesktopError> {
        let mut analyzer = self.analyzer.lock().unwrap();
        let result = self.stop_analyzer(&mut analyzer);
        let _save = self.saves.lock().unwrap();
        result
    }

    pub(crate) fn resume_after_shutdown_error(&self) {
        self.state.lock().unwrap().stopping = false;
    }

    fn analyze(
        &self,
        path: &Path,
        cancel: &CancelToken,
        slot: &mut Option<AnalyzerProcess>,
    ) -> Result<Analysis, DesktopError> {
        check_open(cancel)?;
        let worker = AnalyzerProcess::start(&self.config.worker_binary_path, path)
            .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?;
        let worker = slot.insert(worker);
        let mut output = None;
        loop {
            if cancel.is_cancelled() {
                self.stop_analyzer(slot)?;
                return Err(cancelled_open());
            }
            if output.is_none() {
                match worker.stdout.try_recv() {
                    Ok(Ok(bytes)) => output = Some(bytes),
                    Ok(Err(error)) => {
                        self.stop_analyzer(slot)?;
                        return Err(desktop_error(DesktopErrorCode::Analysis, error));
                    }
                    Err(TryRecvError::Disconnected) => {
                        self.stop_analyzer(slot)?;
                        return Err(DesktopError::new(
                            DesktopErrorCode::Analysis,
                            "Could not read analyzer stdout",
                        ));
                    }
                    Err(TryRecvError::Empty) => (),
                }
            }
            let status = match worker.child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    self.stop_analyzer(slot)?;
                    return Err(desktop_error(DesktopErrorCode::Analysis, error));
                }
            };
            if let Some(status) = status {
                let worker = slot.take().unwrap();
                let stderr = worker.stderr.join().unwrap_or_default();
                if !status.success() {
                    return Err(DesktopError::new(
                        DesktopErrorCode::Analysis,
                        if stderr.is_empty() {
                            format!("Analyzer exited with {status}")
                        } else {
                            stderr
                        },
                    ));
                }
                let bytes = match output {
                    Some(bytes) => bytes,
                    None => worker
                        .stdout
                        .recv()
                        .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?
                        .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?,
                };
                if bytes.first() != Some(&b'{') {
                    return Err(DesktopError::new(
                        DesktopErrorCode::Analysis,
                        "Analyzer must return an Analysis JSON object",
                    ));
                }
                let analysis: Analysis = serde_json::from_slice(&bytes)
                    .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?;
                analysis
                    .validate()
                    .map_err(|error| desktop_error(DesktopErrorCode::Analysis, error))?;
                return Ok(analysis);
            }
            thread::sleep(PROCESS_POLL);
        }
    }

    fn stop_analyzer(&self, slot: &mut Option<AnalyzerProcess>) -> Result<(), DesktopError> {
        let Some(worker) = slot.as_mut() else {
            return Ok(());
        };
        let cleanup_error = |error| desktop_error(DesktopErrorCode::CleanupBlocked, error);
        if worker.child.try_wait().map_err(cleanup_error)?.is_none() {
            if let Err(error) = worker.child.kill() {
                if worker.child.try_wait().map_err(cleanup_error)?.is_none() {
                    return Err(cleanup_error(error));
                }
            }
            let start = Instant::now();
            while worker.child.try_wait().map_err(cleanup_error)?.is_none() {
                if start.elapsed() >= self.config.force_kill_timeout {
                    return Err(DesktopError::new(
                        DesktopErrorCode::CleanupBlocked,
                        "Analyzer did not exit after force kill",
                    ));
                }
                thread::sleep(PROCESS_POLL);
            }
        }
        let worker = slot.take().unwrap();
        let _ = worker.stdout.recv();
        let _ = worker.stderr.join();
        Ok(())
    }
}

struct AnalyzerProcess {
    child: Child,
    stdout: Receiver<io::Result<Vec<u8>>>,
    stderr: JoinHandle<String>,
}

impl AnalyzerProcess {
    fn start(binary: &Path, path: &Path) -> io::Result<Self> {
        let mut child = worker_command(binary)
            .args(["analyze", "--input"])
            .arg(path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        let output = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let (send, stdout) = mpsc::channel();
        thread::spawn(move || {
            let mut output = BufReader::new(output);
            let result = read_line(&mut output, MAX_ANALYSIS_JSON_BYTES).and_then(|line| {
                let mut extra = [0];
                if output.read(&mut extra)? != 0 {
                    return Err(io::Error::other(
                        "Analyzer returned more than one JSON line",
                    ));
                }
                Ok(line.unwrap_or_default())
            });
            let _ = send.send(result);
        });
        Ok(Self {
            child,
            stdout,
            stderr: thread::spawn(move || read_stderr(stderr)),
        })
    }
}

fn read_sidecar(path: &Path) -> Result<Option<DisplayConfig>, DesktopError> {
    let sidecar_error = |error| desktop_error(DesktopErrorCode::Sidecar, error);
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => (),
        Ok(_) => {
            return Err(DesktopError::new(
                DesktopErrorCode::Sidecar,
                "DisplayConfig sidecar must be a file",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            // A dangling sidecar symlink still occupies the sidecar path.
            return match fs::symlink_metadata(path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                _ => Err(sidecar_error(error)),
            };
        }
        Err(error) => return Err(sidecar_error(error)),
    }
    let file = File::open(path).map_err(sidecar_error)?;
    let bytes = read_bounded(file, DISPLAY_CONFIG_JSON_BYTE_LIMIT).map_err(sidecar_error)?;
    DisplayConfig::from_sidecar_json(&bytes).map(Some)
}

struct SidecarTemp(PathBuf);

impl Drop for SidecarTemp {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = remove_if_present(&self.0);
        }
    }
}

fn prepare_sidecar(path: &Path, display: &DisplayConfig) -> Result<SidecarTemp, DesktopError> {
    display.validate()?;
    let sidecar_error = |error| desktop_error(DesktopErrorCode::Sidecar, error);
    let mut json = serde_json::to_string_pretty(display)
        .map_err(|error| desktop_error(DesktopErrorCode::Sidecar, error))?;
    json.push('\n');
    if json.len() > DISPLAY_CONFIG_JSON_BYTE_LIMIT {
        json = serde_json::to_string(display)
            .map_err(|error| desktop_error(DesktopErrorCode::Sidecar, error))?;
        if json.len() > DISPLAY_CONFIG_JSON_BYTE_LIMIT {
            return Err(DesktopError::new(
                DesktopErrorCode::Sidecar,
                "DisplayConfig sidecar exceeds 16 MiB",
            ));
        }
    }
    let path = save_temp_path(path).map_err(sidecar_error)?;
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .map_err(sidecar_error)?;
    let temp = SidecarTemp(path);
    // Drop the file handle before the cleanup guard, including on write errors.
    let mut file = file;
    file.write_all(json.as_bytes())
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(sidecar_error)?;
    Ok(temp)
}

fn require_running(state: &ResultState) -> Result<(), DesktopError> {
    if state.stopping {
        Err(DesktopError::new(
            DesktopErrorCode::Conflict,
            "Desktop host is shutting down",
        ))
    } else {
        Ok(())
    }
}

fn require_session<'a>(state: &'a ResultState, id: &str) -> Result<&'a Session, DesktopError> {
    require_running(state)?;
    state
        .active
        .as_ref()
        .filter(|session| session.id == id)
        .ok_or_else(|| {
            DesktopError::new(
                DesktopErrorCode::Conflict,
                "Result session is no longer active",
            )
        })
}

fn check_revision(revision: &AtomicBool) -> Result<(), DesktopError> {
    if revision.load(Ordering::Relaxed) {
        Ok(())
    } else {
        Err(DesktopError::new(
            DesktopErrorCode::Conflict,
            "The GSR was replaced. Open the result again.",
        ))
    }
}

fn check_open(cancel: &CancelToken) -> Result<(), DesktopError> {
    if cancel.is_cancelled() {
        Err(cancelled_open())
    } else {
        Ok(())
    }
}

fn cancelled_open() -> DesktopError {
    DesktopError::new(DesktopErrorCode::Cancelled, "Result opening was cancelled")
}
