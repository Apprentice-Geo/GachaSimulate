//! Simulation and result session entry points for the desktop shell.

mod files;
mod results;
mod simulation;
mod transport;
mod worker;

use std::{
    path::{Path, PathBuf},
    process::Child,
    sync::{Arc, Mutex},
    time::Duration,
};

use gachasimulate_desktop_contract::{
    AppLink, ConfigSnapshotProvider, DesktopError, DesktopErrorCode, SimulationTaskEvent,
    MAX_DESKTOP_THREADS,
};

pub use results::ResultSessionHost;
pub use simulation::SimulationHost;

#[doc(hidden)]
pub use worker::worker_main;

pub type SimulationEventSink = Arc<dyn Fn(SimulationTaskEvent) + Send + Sync>;
pub type WorkerKiller = Arc<dyn Fn(&mut Child) -> std::io::Result<()> + Send + Sync>;
pub type HostOpener = Arc<dyn Fn(HostOpenTarget) -> Result<(), DesktopError> + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostOpenTarget {
    Url(&'static str),
    Directory(PathBuf),
}

pub struct HostConfig {
    pub results_dir: PathBuf,
    pub worker_binary_path: PathBuf,
    pub event_sink: SimulationEventSink,
    pub cooperative_cancel_timeout: Duration,
    pub force_kill_timeout: Duration,
    pub worker_killer: WorkerKiller,
    pub opener: Option<HostOpener>,
}

impl HostConfig {
    pub fn new(
        results_dir: impl Into<PathBuf>,
        worker_binary_path: impl Into<PathBuf>,
        event_sink: SimulationEventSink,
    ) -> Self {
        Self {
            results_dir: results_dir.into(),
            worker_binary_path: worker_binary_path.into(),
            event_sink,
            cooperative_cancel_timeout: Duration::from_secs(3),
            force_kill_timeout: Duration::from_secs(3),
            worker_killer: Arc::new(Child::kill),
            opener: None,
        }
    }
}

pub struct DesktopHost {
    pub simulation: SimulationHost,
    pub results: ResultSessionHost,
    config: Arc<HostConfig>,
    shutdown_gate: Mutex<()>,
}

impl DesktopHost {
    pub fn new(
        mut config: HostConfig,
        config_snapshots: Arc<dyn ConfigSnapshotProvider>,
    ) -> Result<Self, DesktopError> {
        config.results_dir = std::path::absolute(&config.results_dir)
            .map_err(|error| desktop_error(DesktopErrorCode::Io, error))?;
        config.worker_binary_path = std::path::absolute(&config.worker_binary_path)
            .map_err(|error| desktop_error(DesktopErrorCode::Io, error))?;
        let config = Arc::new(config);
        let files = Arc::new(Mutex::new(files::ResultFiles::default()));
        let simulation = SimulationHost::new(config.clone(), config_snapshots, files.clone())
            .map_err(|error| desktop_error(DesktopErrorCode::Internal, error))?;
        let results = ResultSessionHost::new(config.clone(), simulation.clone(), files);
        Ok(Self {
            simulation,
            results,
            config,
            shutdown_gate: Mutex::new(()),
        })
    }

    pub fn get_logical_cpu_count(&self) -> Result<usize, DesktopError> {
        Ok(logical_cpu_count())
    }

    pub fn results_dir(&self) -> &Path {
        &self.config.results_dir
    }

    pub fn open_results_directory(&self) -> Result<(), DesktopError> {
        std::fs::create_dir_all(self.results_dir())
            .map_err(|error| desktop_error(DesktopErrorCode::Io, error))?;
        self.open(HostOpenTarget::Directory(self.results_dir().to_owned()))
    }

    pub fn open_app_link(&self, link: AppLink) -> Result<(), DesktopError> {
        let url = match link {
            AppLink::Project => "https://github.com/Apprentice-Geo/GachaSimulate#readme",
            AppLink::Issues => "https://github.com/Apprentice-Geo/GachaSimulate/issues",
            AppLink::License => {
                "https://github.com/Apprentice-Geo/GachaSimulate/blob/HEAD/LICENSE.txt"
            }
            AppLink::Notices => {
                "https://github.com/Apprentice-Geo/GachaSimulate/blob/HEAD/THIRD_PARTY_NOTICES.md"
            }
        };
        self.open(HostOpenTarget::Url(url))
    }

    fn open(&self, target: HostOpenTarget) -> Result<(), DesktopError> {
        let opener = self
            .config
            .opener
            .as_ref()
            .ok_or_else(DesktopError::not_implemented)?;
        opener(target)
    }

    pub fn shutdown(&self) -> Result<(), DesktopError> {
        let _shutdown = self.shutdown_gate.lock().unwrap();
        self.results.begin_shutdown();
        self.simulation.begin_shutdown();
        let results = self.results.finish_shutdown();
        let simulation = self.simulation.finish_shutdown();
        let outcome = match (results, simulation) {
            (Err(results), Err(simulation)) => Err(DesktopError::new(
                DesktopErrorCode::CleanupBlocked,
                format!("{results}\n{simulation}"),
            )),
            (results, simulation) => results.and(simulation),
        };
        if outcome.is_err() {
            self.simulation.resume_after_shutdown_error();
            self.results.resume_after_shutdown_error();
        }
        outcome
    }
}

fn desktop_error(code: DesktopErrorCode, message: impl ToString) -> DesktopError {
    DesktopError::new(code, message.to_string())
}

fn logical_cpu_count() -> usize {
    std::thread::available_parallelism()
        .map_or(1, usize::from)
        .clamp(1, MAX_DESKTOP_THREADS)
}
