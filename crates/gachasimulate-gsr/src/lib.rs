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

use std::{
    fs::File,
    io::{BufReader, Read},
    marker::PhantomData,
    path::Path,
};

pub use gachasimulate_types::{
    Analysis, AnalysisResultItem, AnalysisStatistic, AnalysisTotals, AnalysisValidationError,
    GsrError, GsrHeaderMeta, GsrWriteSummary, ResultChunk, ResultChunkWriter, ResultRecord,
    TerminationReasonShare, MAX_ANALYSIS_JSON_BYTES, MAX_CHUNK_RECORDS, MAX_GSR_FILE_BYTES,
    MAX_REASONS, MAX_RUNS, MAX_STRING_BYTES,
};

pub const GSR_MAGIC: [u8; 4] = *b"GSR\0";
pub const GSR_VERSION: u32 = 3;
pub const GSR_HEADER_BYTES: u32 = 48;
pub const GSR_CHUNK_HEADER_BYTES: u64 = 16;
pub const GSR_RECORD_BYTES: u64 = 12;
pub const GSR_TRAILER_BYTES: u64 = 24;

#[derive(Debug)]
pub struct GsrFileWriter {
    meta: GsrHeaderMeta,
}

impl GsrFileWriter {
    /// Opens a caller-selected output path and writes the header and reasons.
    pub fn create(_path: impl AsRef<Path>, _meta: &GsrHeaderMeta) -> Result<Self, GsrError> {
        Err(GsrError::NotImplemented)
    }
}

impl ResultChunkWriter for GsrFileWriter {
    fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    fn write_chunk(&mut self, _chunk: &ResultChunk) -> Result<(), GsrError> {
        Err(GsrError::NotImplemented)
    }

    fn finish(self) -> Result<GsrWriteSummary, GsrError> {
        Err(GsrError::NotImplemented)
    }
}

#[derive(Debug)]
pub struct GsrReader<R: Read> {
    meta: GsrHeaderMeta,
    _reader: PhantomData<R>,
}

impl GsrReader<BufReader<File>> {
    pub fn open(_path: impl AsRef<Path>) -> Result<Self, GsrError> {
        Err(GsrError::NotImplemented)
    }
}

impl<R: Read> GsrReader<R> {
    /// Consumes the header and validates the metadata.
    pub fn new(_reader: R) -> Result<Self, GsrError> {
        Err(GsrError::NotImplemented)
    }

    pub fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    /// Returns None only after validating the trailer and end of stream.
    pub fn next_chunk(&mut self) -> Result<Option<ResultChunk>, GsrError> {
        Err(GsrError::NotImplemented)
    }
}

pub fn analyze_gsr_file(_path: impl AsRef<Path>) -> Result<Analysis, GsrError> {
    Err(GsrError::NotImplemented)
}

pub fn analyze_gsr_reader<R: Read>(_reader: R) -> Result<Analysis, GsrError> {
    Err(GsrError::NotImplemented)
}
