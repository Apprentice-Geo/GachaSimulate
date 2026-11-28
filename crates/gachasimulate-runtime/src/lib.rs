//! Single-run execution and ordered batch scheduling.

pub mod rng;

pub use gachasimulate_types::{
    CancelToken, CompiledProgram, GsrWriteSummary, ResultChunkWriter, ResultRecord,
    SimulationError, SimulationOptions, SimulationProgress, MAX_CHUNK_RECORDS, MAX_FRAME_DEPTH,
    MAX_RUNS, MAX_RUN_STEPS,
};

/// Runs the program with a bounded window of chunks and submits them in run
/// order. Before executing any runs, verifies that `writer.metadata()` matches
/// `GsrHeaderMeta::from_program(program, options)`. Progress reports runs
/// accepted by the writer. Only a complete batch calls the writer's finish
/// method.
pub fn simulate_to_writer<W: ResultChunkWriter, F: FnMut(SimulationProgress) + Send>(
    _program: &CompiledProgram,
    _options: &SimulationOptions,
    _cancel: &CancelToken,
    _writer: W,
    _on_progress: F,
) -> Result<GsrWriteSummary, SimulationError> {
    Err(SimulationError::NotImplemented)
}

/// Returns the selected item's final inventory and the termination reason
/// index for the given global seed and zero-based run index.
pub fn run_single_deterministic(
    _program: &CompiledProgram,
    _seed: i64,
    _run_index: u64,
) -> Result<ResultRecord, SimulationError> {
    Err(SimulationError::NotImplemented)
}
