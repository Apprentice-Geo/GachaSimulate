//! Single-run execution and ordered batch scheduling.

pub mod rng;

mod run;
mod scheduler;

pub use scheduler::{simulate_to_writer, MAX_THREADS};

pub use gachasimulate_types::{
    CancelToken, CompiledProgram, GsrWriteSummary, ResultChunkWriter, ResultRecord,
    SimulationError, SimulationOptions, SimulationProgress, MAX_CHUNK_RECORDS, MAX_FRAME_DEPTH,
    MAX_RUNS, MAX_RUN_STEPS,
};

/// Returns the selected item's final inventory and the termination reason
/// index for the given global seed and zero-based run index.
pub fn run_single_deterministic(
    program: &CompiledProgram,
    seed: i64,
    run_index: u64,
) -> Result<ResultRecord, SimulationError> {
    program.validate_invariants()?;
    run::Scratch::new(program).run(program, seed, run_index, None)
}
