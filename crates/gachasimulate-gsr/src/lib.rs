//! Streaming GSR v3 result I/O and Analysis generation.
//!
//! All integers are little-endian. The fixed header holds the magic, version
//! (u32), fixed header size (u32), flags (u32, zero), total runs (u64), seed
//! (i64), reason count (u32), result ID and name byte lengths (two u32s), and
//! reserved space (u32, zero). It is followed by the UTF-8 ID and name and
//! then the reason strings, each prefixed with its byte length (u32).
//!
//! Each chunk starts with its first run index and record count (two u64s),
//! bounded to `1..=MAX_CHUNK_RECORDS` records per chunk so streaming readers
//! and analyzers maintain a strict per-chunk memory bound.
//! Each record contains the inventory value (u64) and reason index (u32).
//! After the declared number of runs, a fixed trailer holds the total result,
//! chunk count and full file size (three u64s). The trailer permits writing
//! the complete stream without seeking back to the header.

mod analyze;
mod format;

pub use analyze::{analyze_gsr_file, analyze_gsr_reader};
pub use format::{GsrFileWriter, GsrReader};

pub use gachasimulate_types::{
    Analysis, AnalysisResultItem, AnalysisStatistic, AnalysisTotals, AnalysisValidationError,
    GsrError, GsrHeaderMeta, GsrWriteSummary, ResultChunk, ResultChunkWriter, ResultRecord,
    TerminationReasonShare, GSR_HEADER_BYTES, MAX_ANALYSIS_JSON_BYTES, MAX_CHUNK_RECORDS,
    MAX_GSR_FILE_BYTES, MAX_GSR_METADATA_BYTES, MAX_REASONS, MAX_RUNS, MAX_STRING_BYTES,
};

pub const GSR_MAGIC: [u8; 4] = *b"GSR\0";
pub const GSR_VERSION: u32 = 3;
pub const GSR_CHUNK_HEADER_BYTES: u64 = 16;
pub const GSR_RECORD_BYTES: u64 = 12;
pub const GSR_TRAILER_BYTES: u64 = 24;
