use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use thiserror::Error;

use crate::{GsrError, ProgramInvariantError};

pub const MAX_RUN_STEPS: u64 = 1_000_000;
pub const MAX_FRAME_DEPTH: usize = 1_024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimulationOptions {
    pub total_runs: u64,
    pub seed: i64,
    pub threads: usize,
    /// None lets the scheduler choose a chunk size.
    pub chunk_size: Option<u64>,
    /// Bounds the total number of chunks computing or waiting to be written.
    /// None lets the scheduler choose the window.
    pub max_in_flight_chunks: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SimulationProgress {
    pub completed_runs: u64,
    pub total_runs: u64,
}

#[derive(Debug, Clone, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Debug, Error)]
pub enum SimulationError {
    #[error("simulation cancelled")]
    Cancelled,
    #[error("runtime step limit exceeded at run {run_index}")]
    StepLimitExceeded { run_index: u64 },
    #[error("runtime frame depth limit exceeded at run {run_index}")]
    FrameDepthLimitExceeded { run_index: u64 },
    #[error("inventory overflow for item index {item} at run {run_index}")]
    InventoryOverflow { run_index: u64, item: u32 },
    #[error("negative result item value {value} at run {run_index}")]
    NegativeResultItem { run_index: u64, value: i64 },
    #[error("invalid simulation options: {message}")]
    InvalidOptions { message: String },
    #[error("invalid compiled program: {0}")]
    InvalidProgram(#[from] ProgramInvariantError),
    #[error("writer header metadata does not match the compiled program and simulation options")]
    HeaderMismatch,
    #[error(transparent)]
    Writer(#[from] GsrError),
    #[error("simulation is not implemented")]
    NotImplemented,
}
