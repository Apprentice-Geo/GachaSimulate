use std::io;

use thiserror::Error;

use crate::{CompiledProgram, ProgramInvariantError, SimulationOptions};

pub const MAX_RUNS: u64 = 1_000_000_007;
pub const MAX_CHUNK_RECORDS: usize = 1_048_576;
pub const MAX_REASONS: usize = 65_536;
pub const MAX_STRING_BYTES: usize = 1024 * 1024;
pub const GSR_HEADER_BYTES: u32 = 48;
/// Maximum encoded GSR v3 header size, including the fixed header, result item
/// ID and display name, and all reason strings with their u32 length prefixes.
pub const MAX_GSR_METADATA_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_GSR_FILE_BYTES: u64 = 16 * 1024 * 1024 * 1024;
pub const MAX_ANALYSIS_JSON_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResultRecord {
    pub value: u64,
    pub reason_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultChunk {
    /// Zero-based run index of the first record. Records cover consecutive runs.
    pub start_run: u64,
    pub records: Vec<ResultRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GsrHeaderMeta {
    pub total_runs: u64,
    pub seed: i64,
    pub result_item_id: String,
    pub result_item_name: String,
    /// Unique, non-empty reasons in ascending UTF-8 byte order.
    pub reasons: Vec<String>,
}

impl GsrHeaderMeta {
    /// Derives the authoritative result header from a compiled program and run
    /// options so writers and simulations cannot disagree on item or reason
    /// identities.
    pub fn from_program(
        program: &CompiledProgram,
        options: &SimulationOptions,
    ) -> Result<Self, ProgramInvariantError> {
        let item = program.items.get(program.result_item as usize).ok_or(
            ProgramInvariantError::InvalidField {
                field: "result_item",
                message: "item index is out of bounds",
            },
        )?;
        Ok(Self {
            total_runs: options.total_runs,
            seed: options.seed,
            result_item_id: item.id.clone(),
            result_item_name: item.name.clone(),
            reasons: program.reasons.clone(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GsrWriteSummary {
    pub total_runs: u64,
    pub total_result: u64,
    pub chunks_written: u64,
    pub file_size: u64,
}

#[derive(Debug, Error)]
pub enum GsrError {
    #[error("GSR I/O: {0}")]
    Io(#[from] io::Error),
    #[error("invalid GSR magic {found:?}")]
    InvalidMagic { found: [u8; 4] },
    #[error("unsupported GSR version {found}")]
    UnsupportedVersion { found: u32 },
    #[error("invalid GSR header: {message}")]
    InvalidHeader { message: &'static str },
    #[error("invalid GSR trailer: {message}")]
    InvalidTrailer { message: &'static str },
    #[error("invalid GSR UTF-8 in {field}")]
    InvalidUtf8 { field: &'static str },
    #[error("empty result chunk at run {start_run}")]
    EmptyChunk { start_run: u64 },
    #[error("missing result chunk at run {expected_start}")]
    MissingChunk { expected_start: u64 },
    #[error("duplicate or overlapping result chunk at run {start_run}")]
    DuplicateChunk { start_run: u64 },
    #[error("out-of-order result chunk at run {start_run}, expected {expected_start}")]
    OutOfOrderChunk { expected_start: u64, start_run: u64 },
    #[error("reason index {reason_index} at run {run_index} is outside a table of {reason_count}")]
    ReasonIndexOutOfBounds {
        run_index: u64,
        reason_index: u32,
        reason_count: usize,
    },
    #[error("truncated GSR data while reading {section}")]
    TruncatedData { section: &'static str },
    #[error("trailing GSR data")]
    TrailingData,
    #[error("arithmetic overflow computing {field}")]
    ArithmeticOverflow { field: &'static str },
    #[error("{field} exceeds limit of {limit}")]
    LimitExceeded { field: &'static str, limit: u64 },
    #[error("Analysis JSON exceeds {limit} bytes")]
    AnalysisJsonSizeExceeded { limit: usize },
    #[error("GSR operations are not implemented")]
    NotImplemented,
}

/// A sink for a complete stream of non-empty result chunks in run order.
/// Each chunk must hold between 1 and `MAX_CHUNK_RECORDS` records. The first
/// chunk starts at run 0, and each subsequent chunk starts where the preceding
/// chunk ended. Call finish only after all writes succeed.
pub trait ResultChunkWriter {
    /// Returns the header metadata committed for this result stream so the
    /// simulator can verify it matches the compiled program and options before
    /// running.
    fn metadata(&self) -> &GsrHeaderMeta;
    fn write_chunk(&mut self, chunk: &ResultChunk) -> Result<(), GsrError>;
    fn finish(self) -> Result<GsrWriteSummary, GsrError>;
}
