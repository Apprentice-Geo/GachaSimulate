//! Simulation and result session entry points for the desktop shell.

use std::sync::Arc;

use gachasimulate_desktop_contract::{
    AppLink, CancelSimulationRequest, ConfigSnapshotProvider, ConfirmResultSessionRequest,
    ConfirmResultSessionResponse, DesktopError, DiscardResultDraftRequest, ResultCandidateSession,
    SaveResultFieldsRequest, SavedResultFields, SimulationCommandRequest, SimulationTaskSnapshot,
};

pub struct DesktopHost {
    pub simulation: SimulationHost,
    pub results: ResultSessionHost,
}

impl DesktopHost {
    pub fn new(config_snapshots: Arc<dyn ConfigSnapshotProvider>) -> Self {
        Self {
            simulation: SimulationHost::new(config_snapshots),
            results: ResultSessionHost,
        }
    }

    pub fn open_app_link(&self, _link: AppLink) -> Result<(), DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn get_logical_cpu_count(&self) -> Result<usize, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn open_results_directory(&self) -> Result<(), DesktopError> {
        Err(DesktopError::not_implemented())
    }
}

pub struct SimulationHost {
    _config_snapshots: Arc<dyn ConfigSnapshotProvider>,
}

impl SimulationHost {
    pub fn new(config_snapshots: Arc<dyn ConfigSnapshotProvider>) -> Self {
        Self {
            _config_snapshots: config_snapshots,
        }
    }

    pub fn get_simulation_state(&self) -> Result<SimulationTaskSnapshot, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    /// Returns the accepted task snapshot so the caller can bind incoming events.
    pub fn start_simulation(
        &self,
        _request: SimulationCommandRequest,
    ) -> Result<SimulationTaskSnapshot, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    /// Returns the snapshot at cancellation acceptance. Cleanup updates use events.
    pub fn cancel_simulation(
        &self,
        _request: CancelSimulationRequest,
    ) -> Result<SimulationTaskSnapshot, DesktopError> {
        Err(DesktopError::not_implemented())
    }
}

#[derive(Debug, Default)]
pub struct ResultSessionHost;

impl ResultSessionHost {
    pub fn select_gsr_result(&self) -> Result<Option<ResultCandidateSession>, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn open_simulation_result(&self) -> Result<ResultCandidateSession, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    /// A stale confirmation returns false and preserves the current active session.
    pub fn confirm_result_session(
        &self,
        _request: ConfirmResultSessionRequest,
    ) -> Result<ConfirmResultSessionResponse, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn save_result_fields(
        &self,
        _request: SaveResultFieldsRequest,
    ) -> Result<SavedResultFields, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn discard_result_draft(
        &self,
        _request: DiscardResultDraftRequest,
    ) -> Result<(), DesktopError> {
        Err(DesktopError::not_implemented())
    }
}
