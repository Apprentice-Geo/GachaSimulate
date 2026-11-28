use std::{
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicUsize, Ordering},
};

use gachasimulate_gsr::{
    analyze_gsr_file, analyze_gsr_reader, Analysis, AnalysisResultItem, AnalysisStatistic,
    AnalysisTotals, GsrError, GsrFileWriter, GsrHeaderMeta, GsrReader, GsrWriteSummary,
    ResultChunk, ResultChunkWriter, ResultRecord, TerminationReasonShare, GSR_HEADER_BYTES,
    MAX_CHUNK_RECORDS, MAX_GSR_METADATA_BYTES, MAX_REASONS, MAX_RUNS, MAX_STRING_BYTES,
};
use gachasimulate_types::fixtures::{known_results, large_total_results, ResultFixture};

#[path = "api/analysis.rs"]
mod analysis;
#[path = "api/malformed.rs"]
mod malformed;

const KNOWN: &[u8] = include_bytes!("../fixtures/known-results.gsr");
const LARGE_TOTAL: &[u8] = include_bytes!("../fixtures/large-total-9007199254740993.gsr");

struct TempFile(PathBuf);

impl TempFile {
    fn new() -> Self {
        static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
        let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        Self(std::env::temp_dir().join(format!("gsr-test-{}-{sequence}.gsr", std::process::id())))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn write(path: &Path, meta: &GsrHeaderMeta, chunks: &[ResultChunk]) -> GsrWriteSummary {
    let mut writer = GsrFileWriter::create(path, meta).unwrap();
    assert_eq!(writer.metadata(), meta);
    for chunk in chunks {
        writer.write_chunk(chunk).unwrap();
    }
    writer.finish().unwrap()
}

fn chunk(start_run: u64, records: &[(u64, u32)]) -> ResultChunk {
    ResultChunk {
        start_run,
        records: records
            .iter()
            .map(|&(value, reason_index)| ResultRecord {
                value,
                reason_index,
            })
            .collect(),
    }
}

fn share(reason: &str, proportion: u8) -> TerminationReasonShare {
    TerminationReasonShare {
        reason: reason.into(),
        proportion,
    }
}

fn check_fixture(fixture: ResultFixture, filename: &str, bytes: &[u8], expected: Analysis) {
    let temp_file = TempFile::new();
    let summary = write(temp_file.path(), &fixture.meta, &fixture.chunks);
    assert_eq!(fs::read(temp_file.path()).unwrap(), bytes);
    assert_eq!(
        summary,
        GsrWriteSummary {
            total_runs: fixture.meta.total_runs,
            total_result: expected.totals.result.parse().unwrap(),
            chunks_written: fixture.chunks.len() as u64,
            file_size: bytes.len() as u64,
        }
    );

    let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures")
        .join(filename);
    let mut reader = GsrReader::open(&fixture_path).unwrap();
    assert_eq!(reader.metadata(), &fixture.meta);
    for chunk in fixture.chunks {
        assert_eq!(reader.next_chunk().unwrap(), Some(chunk));
    }
    assert_eq!(reader.next_chunk().unwrap(), None);
    assert_eq!(reader.next_chunk().unwrap(), None);
    assert_eq!(analyze_gsr_file(&fixture_path).unwrap(), expected);
    assert_eq!(analyze_gsr_reader(Cursor::new(bytes)).unwrap(), expected);
}

#[test]
fn known_results_binary_and_analysis_match() {
    let fixture = known_results();
    let expected = Analysis {
        result_item: AnalysisResultItem {
            id: "score".into(),
            name: "积分".into(),
        },
        totals: AnalysisTotals {
            runs: "3".into(),
            result: "18".into(),
        },
        values: ["2", "6", "10"].map(String::from).to_vec(),
        cumulative: vec![1.0 / 3.0, 2.0 / 3.0, 1.0],
        statistic: AnalysisStatistic {
            p5: "2".into(),
            p25: "4".into(),
            p50: "6".into(),
            p75: "8".into(),
            p95: "9".into(),
            min: "2".into(),
            mean: "6".into(),
            mean_level: 2.0 / 3.0,
            max: "10".into(),
        },
        termination_reason: vec![share("alpha", 34), share("beta", 33), share("gamma", 33)],
    };
    check_fixture(fixture, "known-results.gsr", KNOWN, expected);
}

#[test]
fn large_total_binary_and_analysis_match() {
    let fixture = large_total_results();
    let lower = "4503599627370496";
    let upper = "4503599627370497";
    let expected = Analysis {
        result_item: AnalysisResultItem {
            id: "score".into(),
            name: "积分".into(),
        },
        totals: AnalysisTotals {
            runs: "2".into(),
            result: "9007199254740993".into(),
        },
        values: vec![lower.into(), upper.into()],
        cumulative: vec![0.5, 1.0],
        statistic: AnalysisStatistic {
            p5: lower.into(),
            p25: lower.into(),
            p50: lower.into(),
            p75: lower.into(),
            p95: lower.into(),
            min: lower.into(),
            mean: lower.into(),
            mean_level: 0.5,
            max: upper.into(),
        },
        termination_reason: vec![share("done", 100)],
    };
    check_fixture(
        fixture,
        "large-total-9007199254740993.gsr",
        LARGE_TOTAL,
        expected,
    );
}

#[test]
fn writer_rejects_invalid_metadata_before_opening_the_path() {
    let fixture = known_results();
    let mutations: &[fn(&mut GsrHeaderMeta)] = &[
        |meta| meta.total_runs = 0,
        |meta| meta.total_runs = MAX_RUNS + 1,
        |meta| meta.result_item_id.clear(),
        |meta| meta.result_item_id = "1score".into(),
        |meta| meta.result_item_id = "score-id".into(),
        |meta| meta.result_item_id = "积分".into(),
        |meta| meta.result_item_id = "a".repeat(MAX_STRING_BYTES + 1),
        |meta| meta.result_item_name.clear(),
        |meta| meta.result_item_name = "名".repeat(MAX_STRING_BYTES / 3 + 1),
        |meta| meta.reasons.clear(),
        |meta| meta.reasons = vec![String::new(); MAX_REASONS + 1],
        |meta| meta.reasons[0].clear(),
        |meta| meta.reasons[0] = "a".repeat(MAX_STRING_BYTES + 1),
        |meta| meta.reasons.swap(0, 1),
        |meta| meta.reasons[1] = meta.reasons[0].clone(),
    ];
    let output = TempFile::new();
    fs::write(output.path(), b"existing").unwrap();
    for mutate in mutations {
        let mut meta = fixture.meta.clone();
        mutate(&mut meta);
        assert!(matches!(
            GsrFileWriter::create(output.path(), &meta),
            Err(GsrError::InvalidHeader { .. } | GsrError::LimitExceeded { .. })
        ));
        assert_eq!(fs::read(output.path()).unwrap(), b"existing");
    }
}

#[test]
fn metadata_limit_includes_the_fixed_header_and_reason_length_prefixes() {
    let mut meta = known_results().meta;
    meta.total_runs = 1;
    let reason_count = MAX_GSR_METADATA_BYTES as usize / MAX_STRING_BYTES;
    let fixed_bytes = GSR_HEADER_BYTES as usize
        + meta.result_item_id.len()
        + meta.result_item_name.len()
        + reason_count * size_of::<u32>();
    let last_reason_len =
        MAX_GSR_METADATA_BYTES as usize - fixed_bytes - (reason_count - 1) * MAX_STRING_BYTES;
    meta.reasons = (0..reason_count)
        .map(|index| {
            let length = if index == reason_count - 1 {
                last_reason_len
            } else {
                MAX_STRING_BYTES
            };
            let prefix = format!("{index:05}");
            format!("{prefix}{}", "x".repeat(length - prefix.len()))
        })
        .collect();

    let output = TempFile::new();
    let only_chunk = chunk(0, &[(0, 0)]);
    write(output.path(), &meta, std::slice::from_ref(&only_chunk));
    meta.reasons.last_mut().unwrap().push('x');
    assert!(matches!(
        GsrFileWriter::create(output.path(), &meta),
        Err(GsrError::LimitExceeded {
            field: "header metadata",
            limit: MAX_GSR_METADATA_BYTES
        })
    ));
    drop(meta);

    let mut reader = GsrReader::open(output.path()).unwrap();
    assert_eq!(reader.next_chunk().unwrap(), Some(only_chunk));
    assert_eq!(reader.next_chunk().unwrap(), None);
    drop(reader);

    // Supply only the oversized length prefix. The limit error must take
    // precedence over reading the missing string payload.
    let last_length_offset =
        MAX_GSR_METADATA_BYTES - last_reason_len as u64 - size_of::<u32>() as u64;
    let oversized_len = (last_reason_len as u32 + 1).to_le_bytes();
    let stream = File::open(output.path())
        .unwrap()
        .take(last_length_offset)
        .chain(oversized_len.as_slice());
    assert!(matches!(
        GsrReader::new(stream),
        Err(GsrError::LimitExceeded {
            field: "header metadata",
            limit: MAX_GSR_METADATA_BYTES
        })
    ));
}

#[test]
fn writer_can_retry_after_chunk_validation_errors() {
    let fixture = known_results();
    let output = TempFile::new();
    let mut writer = GsrFileWriter::create(output.path(), &fixture.meta).unwrap();
    assert!(matches!(
        writer.write_chunk(&chunk(0, &[])),
        Err(GsrError::EmptyChunk { start_run: 0 })
    ));
    assert!(matches!(
        writer.write_chunk(&chunk(1, &[(0, 0)])),
        Err(GsrError::OutOfOrderChunk {
            expected_start: 0,
            start_run: 1
        })
    ));
    let oversized = ResultChunk {
        start_run: 0,
        records: vec![
            ResultRecord {
                value: 0,
                reason_index: 0
            };
            MAX_CHUNK_RECORDS + 1
        ],
    };
    assert!(matches!(
        writer.write_chunk(&oversized),
        Err(GsrError::LimitExceeded {
            field: "chunk records",
            ..
        })
    ));
    assert!(matches!(
        writer.write_chunk(&chunk(0, &[(0, 0); 4])),
        Err(GsrError::LimitExceeded {
            field: "runs written",
            limit: 3
        })
    ));
    assert!(matches!(
        writer.write_chunk(&chunk(0, &[(50, 0), (0, 3)])),
        Err(GsrError::ReasonIndexOutOfBounds {
            run_index: 1,
            reason_index: 3,
            reason_count: 3
        })
    ));
    writer.write_chunk(&fixture.chunks[0]).unwrap();
    assert!(matches!(
        writer.write_chunk(&fixture.chunks[0]),
        Err(GsrError::DuplicateChunk { start_run: 0 })
    ));
    assert!(matches!(
        writer.write_chunk(&chunk(2, &[(u64::MAX, 0)])),
        Err(GsrError::ArithmeticOverflow {
            field: "total result"
        })
    ));
    writer.write_chunk(&fixture.chunks[1]).unwrap();
    assert_eq!(writer.finish().unwrap().total_result, 18);
    assert_eq!(fs::read(output.path()).unwrap(), KNOWN);
}

#[test]
fn writer_refuses_to_finish_an_incomplete_stream() {
    let fixture = known_results();
    let output = TempFile::new();
    let mut writer = GsrFileWriter::create(output.path(), &fixture.meta).unwrap();
    writer.write_chunk(&fixture.chunks[0]).unwrap();
    assert!(matches!(
        writer.finish(),
        Err(GsrError::MissingChunk { expected_start: 2 })
    ));
}
