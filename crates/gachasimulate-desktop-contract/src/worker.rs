use gachasimulate_types::SimulationOptions;
use serde::{Deserialize, Deserializer, Serialize};

use crate::config::ConfigSnapshotWire;
use crate::simulation::total_result;
use crate::{ConfigSnapshot, SimulationStage};

/// A host-created job. The worker compiles the embedded YAML and writes only
/// to the temporary path allocated by the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSimulationJob {
    #[serde(with = "ConfigSnapshotWire")]
    pub snapshot: ConfigSnapshot,
    pub termination_file: String,
    pub result_item: String,
    pub options: WorkerSimulationOptions,
    pub temp_output_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerSimulationOptions {
    pub total_runs: u64,
    pub seed: i64,
    pub threads: usize,
    pub chunk_size: Option<u64>,
    pub max_in_flight_chunks: Option<usize>,
}

impl From<SimulationOptions> for WorkerSimulationOptions {
    fn from(options: SimulationOptions) -> Self {
        Self {
            total_runs: options.total_runs,
            seed: options.seed,
            threads: options.threads,
            chunk_size: options.chunk_size,
            max_in_flight_chunks: options.max_in_flight_chunks,
        }
    }
}

impl From<WorkerSimulationOptions> for SimulationOptions {
    fn from(options: WorkerSimulationOptions) -> Self {
        Self {
            total_runs: options.total_runs,
            seed: options.seed,
            threads: options.threads,
            chunk_size: options.chunk_size,
            max_in_flight_chunks: options.max_in_flight_chunks,
        }
    }
}

/// JSON Lines emitted by the worker. The host owns desktop task IDs and
/// sequences, and verifies the output and exit status before committing it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkerSimulationEvent {
    #[serde(deserialize_with = "deserialize_started")]
    Started,
    Stage {
        stage: SimulationStage,
    },
    Progress {
        completed_runs: u64,
        total_runs: u64,
    },
    Completed {
        total_runs: u64,
        #[serde(with = "total_result")]
        total_result: String,
        chunks_written: u64,
        file_size: u64,
    },
    Error {
        message: String,
    },
}

fn deserialize_started<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    // Serde's default internally tagged unit variant ignores payload fields.
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct StartedFields {}

    StartedFields::deserialize(deserializer).map(|_| ())
}
