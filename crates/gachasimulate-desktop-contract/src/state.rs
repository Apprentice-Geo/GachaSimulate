use crate::simulation::{is_u64_decimal, safe_filename, MAX_SAFE_JSON_INTEGER};
use crate::{
    DesktopError, DesktopErrorCode, SimulationStage, SimulationStatus, SimulationTaskEvent,
    SimulationTaskSnapshot, MAX_RUNS,
};

/// The host serializes access to this state and assigns increasing task IDs.
/// The sequence increases across tasks and advances only for accepted updates.
#[derive(Debug, Default)]
pub struct SimulationTaskStateMachine {
    snapshot: SimulationTaskSnapshot,
    pending_failure: Option<String>,
}

impl SimulationTaskStateMachine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn snapshot(&self) -> &SimulationTaskSnapshot {
        &self.snapshot
    }

    pub fn start(
        &mut self,
        task_id: u64,
        total_runs: u64,
    ) -> Result<SimulationTaskEvent, DesktopError> {
        if self.is_active() || self.snapshot.status == SimulationStatus::Cancelling {
            return Err(DesktopError::new(
                DesktopErrorCode::Conflict,
                "A simulation still owns the task slot",
            ));
        }
        if task_id <= self.snapshot.task_id.unwrap_or(0) || task_id > MAX_SAFE_JSON_INTEGER {
            return Err(DesktopError::invalid_request(
                "taskId must be an increasing safe integer",
            ));
        }
        if !(1..=MAX_RUNS).contains(&total_runs) {
            return Err(DesktopError::invalid_request("totalRuns is out of range"));
        }
        self.snapshot = SimulationTaskSnapshot {
            task_id: Some(task_id),
            seq: self.snapshot.seq,
            status: SimulationStatus::Starting,
            stage: Some(SimulationStage::LoadingConfig),
            total_runs,
            ..SimulationTaskSnapshot::default()
        };
        Ok(self.emit(task_id))
    }

    pub fn set_stage(
        &mut self,
        task_id: u64,
        stage: SimulationStage,
    ) -> Option<SimulationTaskEvent> {
        use SimulationStage::{Saving, Simulating};
        use SimulationStatus::{Running, Starting};
        let status = match (self.snapshot.status, stage) {
            (Starting, Simulating) => Running,
            (Running, Saving) => SimulationStatus::Saving,
            _ => return None,
        };
        if self.snapshot.task_id != Some(task_id) {
            return None;
        }
        self.snapshot.status = status;
        self.snapshot.stage = Some(stage);
        Some(self.emit(task_id))
    }

    pub fn progress(
        &mut self,
        task_id: u64,
        completed_runs: u64,
        total_runs: u64,
    ) -> Option<SimulationTaskEvent> {
        if self.snapshot.task_id != Some(task_id)
            || self.snapshot.status != SimulationStatus::Running
            || total_runs != self.snapshot.total_runs
            || completed_runs <= self.snapshot.completed_runs
            || completed_runs > total_runs
        {
            return None;
        }
        self.snapshot.completed_runs = completed_runs;
        Some(self.emit(task_id))
    }

    /// Hold the same host lock for this check, the final output commit and
    /// complete(), so a cancel request cannot be accepted between them and
    /// invalid completion metadata never reaches the final destination.
    pub fn can_commit(
        &self,
        task_id: u64,
        total_runs: u64,
        total_result: &str,
        result_filename: &str,
    ) -> bool {
        self.snapshot.task_id == Some(task_id)
            && matches!(
                self.snapshot.status,
                SimulationStatus::Running | SimulationStatus::Saving
            )
            && total_runs == self.snapshot.total_runs
            && is_u64_decimal(total_result)
            && safe_filename(result_filename)
    }

    /// Records success after the host verified the worker exit and committed
    /// its output. A worker's Completed message alone cannot commit success.
    pub fn complete(
        &mut self,
        task_id: u64,
        total_runs: u64,
        total_result: String,
        result_filename: String,
    ) -> Option<SimulationTaskEvent> {
        if !self.can_commit(task_id, total_runs, &total_result, &result_filename) {
            return None;
        }
        self.snapshot.status = SimulationStatus::Completed;
        self.snapshot.completed_runs = total_runs;
        self.snapshot.total_result = Some(total_result);
        self.snapshot.result_filename = Some(result_filename);
        Some(self.emit(task_id))
    }

    /// Release the task slot after the worker is reaped and its temporary
    /// output is removed. Use [`Self::fail_cleanup_retryable`] if cleanup is blocked.
    pub fn fail(&mut self, task_id: u64, message: String) -> Option<SimulationTaskEvent> {
        if self.snapshot.task_id != Some(task_id) || !self.is_active() {
            return None;
        }
        self.snapshot.status = SimulationStatus::Failed;
        self.snapshot.message = Some(message);
        Some(self.emit(task_id))
    }

    /// Retain the task slot and the original failure until cleanup succeeds.
    pub fn fail_cleanup_retryable(
        &mut self,
        task_id: u64,
        failure_message: String,
        cleanup_message: String,
    ) -> Option<SimulationTaskEvent> {
        if self.snapshot.task_id != Some(task_id) {
            return None;
        }
        if self.is_active() {
            self.pending_failure = Some(failure_message);
            self.snapshot.status = SimulationStatus::Cancelling;
        } else if self.pending_failure.is_none() {
            return None;
        }
        self.cancel_retryable(task_id, cleanup_message)
    }

    /// Acceptance is irreversible. A retry clears the previous cleanup error
    /// and keeps the same task and frozen worker readings.
    pub fn request_cancel(&mut self, task_id: u64) -> Result<SimulationTaskEvent, DesktopError> {
        if self.snapshot.task_id != Some(task_id) {
            return Err(DesktopError::new(
                DesktopErrorCode::NotFound,
                "Simulation task is no longer current",
            ));
        }
        if self.is_active() {
            self.pending_failure = None;
        } else if !(self.is_cancelling(task_id) && self.snapshot.cancel_retryable) {
            return Err(DesktopError::new(
                DesktopErrorCode::Conflict,
                "Simulation task cannot be cancelled in its current state",
            ));
        }
        self.snapshot.status = SimulationStatus::Cancelling;
        self.snapshot.message = None;
        self.snapshot.cancel_retryable = false;
        Ok(self.emit(task_id))
    }

    pub fn cancel_retryable(
        &mut self,
        task_id: u64,
        message: String,
    ) -> Option<SimulationTaskEvent> {
        if !self.is_cancelling(task_id) || self.snapshot.cancel_retryable {
            return None;
        }
        self.snapshot.message = Some(match &self.pending_failure {
            Some(failure) => format!("{failure}\nCleanup must be retried. {message}"),
            None => message,
        });
        self.snapshot.cancel_retryable = true;
        Some(self.emit(task_id))
    }

    /// Records completed cleanup for a user cancellation.
    pub fn cancelled(&mut self, task_id: u64) -> Option<SimulationTaskEvent> {
        if self.pending_failure.is_some() {
            return None;
        }
        self.finish_cleanup(task_id)
    }

    /// Settle to the original outcome after the worker stops and cleanup succeeds.
    pub fn finish_cleanup(&mut self, task_id: u64) -> Option<SimulationTaskEvent> {
        if !self.is_cancelling(task_id) {
            return None;
        }
        self.snapshot.message = self.pending_failure.take();
        self.snapshot.status = if self.snapshot.message.is_some() {
            SimulationStatus::Failed
        } else {
            SimulationStatus::Cancelled
        };
        self.snapshot.cancel_retryable = false;
        Some(self.emit(task_id))
    }

    fn is_active(&self) -> bool {
        matches!(
            self.snapshot.status,
            SimulationStatus::Starting | SimulationStatus::Running | SimulationStatus::Saving
        )
    }

    fn is_cancelling(&self, task_id: u64) -> bool {
        self.snapshot.task_id == Some(task_id)
            && self.snapshot.status == SimulationStatus::Cancelling
    }

    fn emit(&mut self, task_id: u64) -> SimulationTaskEvent {
        assert!(
            self.snapshot.seq < MAX_SAFE_JSON_INTEGER,
            "desktop simulation sequence exhausted"
        );
        self.snapshot.seq += 1;
        SimulationTaskEvent {
            task_id,
            seq: self.snapshot.seq,
            snapshot: self.snapshot.clone(),
        }
    }
}
