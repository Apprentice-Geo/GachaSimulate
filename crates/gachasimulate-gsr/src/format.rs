use std::{
    fs::File,
    io::{self, BufReader, BufWriter, Read, Write},
    path::Path,
};

use crate::{
    GsrError, GsrHeaderMeta, GsrWriteSummary, ResultChunk, ResultChunkWriter, ResultRecord,
    GSR_CHUNK_HEADER_BYTES, GSR_HEADER_BYTES, GSR_MAGIC, GSR_RECORD_BYTES, GSR_TRAILER_BYTES,
    GSR_VERSION, MAX_CHUNK_RECORDS, MAX_GSR_FILE_BYTES, MAX_GSR_METADATA_BYTES, MAX_REASONS,
    MAX_RUNS, MAX_STRING_BYTES,
};

#[derive(Debug, Default)]
struct Progress {
    next_run: u64,
    total_result: u64,
    chunks: u64,
}

impl Progress {
    fn complete_chunk(&mut self, end: u64, total_result: u64) {
        self.next_run = end;
        self.total_result = total_result;
        self.chunks += 1;
    }
}

#[derive(Debug)]
pub struct GsrFileWriter {
    meta: GsrHeaderMeta,
    output: BufWriter<File>,
    progress: Progress,
    bytes_written: u64,
    write_failed: bool,
}

impl GsrFileWriter {
    /// Opens a caller-selected output path and writes the header and reasons.
    pub fn create(path: impl AsRef<Path>, meta: &GsrHeaderMeta) -> Result<Self, GsrError> {
        let bytes_written = validate_metadata(meta)?;
        let mut output = BufWriter::new(File::create(path)?);
        output.write_all(&GSR_MAGIC)?;
        output.write_all(&GSR_VERSION.to_le_bytes())?;
        output.write_all(&GSR_HEADER_BYTES.to_le_bytes())?;
        output.write_all(&0u32.to_le_bytes())?;
        output.write_all(&meta.total_runs.to_le_bytes())?;
        output.write_all(&meta.seed.to_le_bytes())?;
        output.write_all(&(meta.reasons.len() as u32).to_le_bytes())?;
        output.write_all(&(meta.result_item_id.len() as u32).to_le_bytes())?;
        output.write_all(&(meta.result_item_name.len() as u32).to_le_bytes())?;
        output.write_all(&0u32.to_le_bytes())?;
        output.write_all(meta.result_item_id.as_bytes())?;
        output.write_all(meta.result_item_name.as_bytes())?;
        for reason in &meta.reasons {
            output.write_all(&(reason.len() as u32).to_le_bytes())?;
            output.write_all(reason.as_bytes())?;
        }
        Ok(Self {
            meta: meta.clone(),
            output,
            progress: Progress::default(),
            bytes_written,
            write_failed: false,
        })
    }

    fn check_output(&self) -> io::Result<()> {
        if self.write_failed {
            return Err(io::Error::other(
                "GSR output failed during a previous write",
            ));
        }
        Ok(())
    }
}

impl ResultChunkWriter for GsrFileWriter {
    fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    fn write_chunk(&mut self, chunk: &ResultChunk) -> Result<(), GsrError> {
        self.check_output()?;
        let count = chunk.records.len() as u64;
        let end = chunk_end(
            chunk.start_run,
            count,
            self.progress.next_run,
            self.meta.total_runs,
        )?;
        let bytes_written = file_end(
            self.bytes_written,
            GSR_CHUNK_HEADER_BYTES + count * GSR_RECORD_BYTES + GSR_TRAILER_BYTES,
        )? - GSR_TRAILER_BYTES;
        let mut total_result = self.progress.total_result;
        for (offset, record) in chunk.records.iter().enumerate() {
            total_result = add_record(
                total_result,
                *record,
                chunk.start_run + offset as u64,
                self.meta.reasons.len(),
            )?;
        }

        write_records(&mut self.output, chunk).inspect_err(|_| self.write_failed = true)?;
        self.progress.complete_chunk(end, total_result);
        self.bytes_written = bytes_written;
        Ok(())
    }

    fn finish(mut self) -> Result<GsrWriteSummary, GsrError> {
        self.check_output()?;
        if self.progress.next_run != self.meta.total_runs {
            return Err(GsrError::MissingChunk {
                expected_start: self.progress.next_run,
            });
        }

        let summary = GsrWriteSummary {
            total_runs: self.meta.total_runs,
            total_result: self.progress.total_result,
            chunks_written: self.progress.chunks,
            file_size: file_end(self.bytes_written, GSR_TRAILER_BYTES)?,
        };
        self.output.write_all(&summary.total_result.to_le_bytes())?;
        self.output
            .write_all(&summary.chunks_written.to_le_bytes())?;
        self.output.write_all(&summary.file_size.to_le_bytes())?;
        self.output.flush()?;
        Ok(summary)
    }
}

fn write_records(output: &mut BufWriter<File>, chunk: &ResultChunk) -> io::Result<()> {
    output.write_all(&chunk.start_run.to_le_bytes())?;
    output.write_all(&(chunk.records.len() as u64).to_le_bytes())?;
    let mut bytes = [0; GSR_RECORD_BYTES as usize];
    for record in &chunk.records {
        bytes[..8].copy_from_slice(&record.value.to_le_bytes());
        bytes[8..].copy_from_slice(&record.reason_index.to_le_bytes());
        output.write_all(&bytes)?;
    }
    Ok(())
}

#[derive(Debug)]
pub struct GsrReader<R: Read> {
    input: Input<R>,
    meta: GsrHeaderMeta,
    progress: Progress,
    finished: bool,
    read_failed: bool,
}

impl GsrReader<BufReader<File>> {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, GsrError> {
        let file = File::open(path)?;
        file_end(0, file.metadata()?.len())?;
        Self::new(BufReader::new(file))
    }
}

impl<R: Read> GsrReader<R> {
    /// Consumes the header and validates the metadata.
    pub fn new(reader: R) -> Result<Self, GsrError> {
        let mut input = Input {
            reader,
            bytes_read: 0,
        };
        let meta = read_metadata(&mut input)?;
        Ok(Self {
            input,
            meta,
            progress: Progress::default(),
            finished: false,
            read_failed: false,
        })
    }

    pub fn metadata(&self) -> &GsrHeaderMeta {
        &self.meta
    }

    /// Returns the final chunk before validating the trailer. The following
    /// call validates the trailer and EOF before returning `None`.
    /// A read error ends the stream.
    pub fn next_chunk(&mut self) -> Result<Option<ResultChunk>, GsrError> {
        if self.read_failed {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "GSR input failed during a previous read",
            )
            .into());
        }
        if self.finished {
            return Ok(None);
        }
        let result = if self.progress.next_run == self.meta.total_runs {
            self.read_trailer().map(|()| {
                self.finished = true;
                None
            })
        } else {
            self.read_chunk().map(Some)
        };
        self.read_failed = result.is_err();
        result
    }

    pub(crate) fn total_result(&self) -> u64 {
        self.progress.total_result
    }

    pub(crate) fn into_metadata(self) -> GsrHeaderMeta {
        self.meta
    }

    fn read_chunk(&mut self) -> Result<ResultChunk, GsrError> {
        let header = self
            .input
            .fixed::<{ GSR_CHUNK_HEADER_BYTES as usize }>("chunk header")?;
        let start_run = u64_at(&header, 0);
        let count = u64_at(&header, 8);
        let end = chunk_end(
            start_run,
            count,
            self.progress.next_run,
            self.meta.total_runs,
        )?;
        file_end(
            self.input.bytes_read,
            count * GSR_RECORD_BYTES + GSR_TRAILER_BYTES,
        )?;

        let mut records = Vec::with_capacity(count as usize);
        let mut total_result = self.progress.total_result;
        for run_index in start_run..end {
            let bytes = self
                .input
                .fixed::<{ GSR_RECORD_BYTES as usize }>("chunk record")?;
            let record = ResultRecord {
                value: u64_at(&bytes, 0),
                reason_index: u32_at(&bytes, 8),
            };
            total_result = add_record(total_result, record, run_index, self.meta.reasons.len())?;
            records.push(record);
        }
        self.progress.complete_chunk(end, total_result);
        Ok(ResultChunk { start_run, records })
    }

    fn read_trailer(&mut self) -> Result<(), GsrError> {
        let bytes = self
            .input
            .fixed::<{ GSR_TRAILER_BYTES as usize }>("trailer")?;
        for (declared, actual, message) in [
            (
                u64_at(&bytes, 0),
                self.progress.total_result,
                "total result mismatch",
            ),
            (
                u64_at(&bytes, 8),
                self.progress.chunks,
                "chunk count mismatch",
            ),
            (
                u64_at(&bytes, 16),
                self.input.bytes_read,
                "file size mismatch",
            ),
        ] {
            if declared != actual {
                return Err(GsrError::InvalidTrailer { message });
            }
        }
        loop {
            match self.input.reader.read(&mut [0]) {
                Ok(0) => return Ok(()),
                Ok(_) => return Err(GsrError::TrailingData),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(error.into()),
            }
        }
    }
}

#[derive(Debug)]
struct Input<R> {
    reader: R,
    bytes_read: u64,
}

impl<R: Read> Input<R> {
    fn read_exact(&mut self, bytes: &mut [u8], section: &'static str) -> Result<(), GsrError> {
        let end = file_end(self.bytes_read, bytes.len() as u64)?;
        self.reader.read_exact(bytes).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                GsrError::TruncatedData { section }
            } else {
                GsrError::Io(error)
            }
        })?;
        self.bytes_read = end;
        Ok(())
    }

    fn fixed<const N: usize>(&mut self, section: &'static str) -> Result<[u8; N], GsrError> {
        let mut bytes = [0; N];
        self.read_exact(&mut bytes, section)?;
        Ok(bytes)
    }

    fn metadata_string(&mut self, len: usize, field: &'static str) -> Result<String, GsrError> {
        validate_length(len as u64, MAX_STRING_BYTES as u64, field)?;
        validate_length(
            self.bytes_read + len as u64,
            MAX_GSR_METADATA_BYTES,
            "header metadata",
        )?;
        let mut bytes = vec![0; len];
        self.read_exact(&mut bytes, field)?;
        String::from_utf8(bytes).map_err(|_| GsrError::InvalidUtf8 { field })
    }
}

fn read_metadata<R: Read>(input: &mut Input<R>) -> Result<GsrHeaderMeta, GsrError> {
    let header = input.fixed::<{ GSR_HEADER_BYTES as usize }>("header")?;
    let found = header[..4].try_into().unwrap();
    if found != GSR_MAGIC {
        return Err(GsrError::InvalidMagic { found });
    }
    let version = u32_at(&header, 4);
    if version != GSR_VERSION {
        return Err(GsrError::UnsupportedVersion { found: version });
    }
    if u32_at(&header, 8) != GSR_HEADER_BYTES
        || u32_at(&header, 12) != 0
        || u32_at(&header, 44) != 0
    {
        return Err(GsrError::InvalidHeader {
            message: "invalid fixed header size, flags or reserved bytes",
        });
    }
    let total_runs = u64_at(&header, 16);
    let reason_count = u32_at(&header, 32);
    validate_length(total_runs, MAX_RUNS, "total runs")?;
    validate_length(u64::from(reason_count), MAX_REASONS as u64, "reason count")?;

    let result_item_id = input.metadata_string(u32_at(&header, 36) as usize, "result item ID")?;
    validate_identifier(&result_item_id)?;
    let result_item_name =
        input.metadata_string(u32_at(&header, 40) as usize, "result item name")?;
    let mut reasons: Vec<String> = Vec::with_capacity(reason_count as usize);
    for _ in 0..reason_count {
        let len = u32::from_le_bytes(input.fixed("reason length")?) as usize;
        let reason = input.metadata_string(len, "reason")?;
        validate_reason_order(reasons.last().map(String::as_str), &reason)?;
        reasons.push(reason);
    }
    Ok(GsrHeaderMeta {
        total_runs,
        seed: i64::from_le_bytes(header[24..32].try_into().unwrap()),
        result_item_id,
        result_item_name,
        reasons,
    })
}

fn validate_metadata(meta: &GsrHeaderMeta) -> Result<u64, GsrError> {
    validate_length(meta.total_runs, MAX_RUNS, "total runs")?;
    validate_length(
        meta.reasons.len() as u64,
        MAX_REASONS as u64,
        "reason count",
    )?;
    validate_length(
        meta.result_item_id.len() as u64,
        MAX_STRING_BYTES as u64,
        "result item ID",
    )?;
    validate_identifier(&meta.result_item_id)?;
    validate_length(
        meta.result_item_name.len() as u64,
        MAX_STRING_BYTES as u64,
        "result item name",
    )?;

    let mut size = u64::from(GSR_HEADER_BYTES)
        + meta.result_item_id.len() as u64
        + meta.result_item_name.len() as u64;
    let mut previous_reason = None;
    for reason in &meta.reasons {
        validate_length(reason.len() as u64, MAX_STRING_BYTES as u64, "reason")?;
        size += 4 + reason.len() as u64;
        validate_length(size, MAX_GSR_METADATA_BYTES, "header metadata")?;
        validate_reason_order(previous_reason, reason)?;
        previous_reason = Some(reason.as_str());
    }
    file_end(size, GSR_TRAILER_BYTES)?;
    Ok(size)
}

fn validate_length(len: u64, limit: u64, field: &'static str) -> Result<(), GsrError> {
    if len == 0 {
        return Err(GsrError::InvalidHeader { message: field });
    }
    if len > limit {
        return Err(GsrError::LimitExceeded { field, limit });
    }
    Ok(())
}

fn validate_identifier(id: &str) -> Result<(), GsrError> {
    let mut bytes = id.bytes();
    if !matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err(GsrError::InvalidHeader {
            message: "invalid result item ID",
        });
    }
    Ok(())
}

fn validate_reason_order(previous: Option<&str>, reason: &str) -> Result<(), GsrError> {
    if previous.is_some_and(|previous| previous >= reason) {
        return Err(GsrError::InvalidHeader {
            message: "reasons must be sorted and unique",
        });
    }
    Ok(())
}

fn chunk_end(start: u64, count: u64, next: u64, total: u64) -> Result<u64, GsrError> {
    if start < next {
        return Err(GsrError::DuplicateChunk { start_run: start });
    }
    if start > next {
        return Err(GsrError::OutOfOrderChunk {
            expected_start: next,
            start_run: start,
        });
    }
    if count == 0 {
        return Err(GsrError::EmptyChunk { start_run: start });
    }
    if count > MAX_CHUNK_RECORDS as u64 {
        return Err(GsrError::LimitExceeded {
            field: "chunk records",
            limit: MAX_CHUNK_RECORDS as u64,
        });
    }
    let end = start
        .checked_add(count)
        .ok_or(GsrError::ArithmeticOverflow { field: "chunk end" })?;
    if end > total {
        return Err(GsrError::LimitExceeded {
            field: "runs written",
            limit: total,
        });
    }
    Ok(end)
}

fn add_record(
    total: u64,
    record: ResultRecord,
    run_index: u64,
    reason_count: usize,
) -> Result<u64, GsrError> {
    if record.reason_index as usize >= reason_count {
        return Err(GsrError::ReasonIndexOutOfBounds {
            run_index,
            reason_index: record.reason_index,
            reason_count,
        });
    }
    total
        .checked_add(record.value)
        .ok_or(GsrError::ArithmeticOverflow {
            field: "total result",
        })
}

fn file_end(offset: u64, len: u64) -> Result<u64, GsrError> {
    match offset.checked_add(len) {
        Some(end) if end <= MAX_GSR_FILE_BYTES => Ok(end),
        _ => Err(GsrError::LimitExceeded {
            field: "GSR file bytes",
            limit: MAX_GSR_FILE_BYTES,
        }),
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn u64_at(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn chunk_payload_must_leave_room_for_the_trailer() {
        let bytes = include_bytes!("../fixtures/known-results.gsr");
        let mut reader = GsrReader::new(Cursor::new(bytes)).unwrap();
        let header_end = reader.input.reader.position();
        reader.input.bytes_read =
            MAX_GSR_FILE_BYTES - GSR_CHUNK_HEADER_BYTES - 2 * GSR_RECORD_BYTES - GSR_TRAILER_BYTES
                + 1;
        assert!(matches!(
            reader.next_chunk(),
            Err(GsrError::LimitExceeded {
                field: "GSR file bytes",
                limit: MAX_GSR_FILE_BYTES,
            })
        ));
        assert_eq!(
            reader.input.reader.position(),
            header_end + GSR_CHUNK_HEADER_BYTES
        );
    }
}
