use std::{
    fs::File,
    io::{self, Read, Seek},
    ops::Range,
};

use gachasimulate_gsr::{
    analyze_gsr_file, analyze_gsr_reader, Analysis, AnalysisValidationError, GsrError,
    GsrHeaderMeta, GSR_CHUNK_HEADER_BYTES, GSR_HEADER_BYTES, GSR_RECORD_BYTES, GSR_TRAILER_BYTES,
    MAX_ANALYSIS_JSON_BYTES, MAX_STRING_BYTES,
};

use super::{chunk, share, write, TempFile, LARGE_TOTAL};

fn analyze_records(records: &[(u64, u32)], reasons: &[&str]) -> Analysis {
    let meta = GsrHeaderMeta {
        total_runs: records.len() as u64,
        seed: i64::MIN,
        result_item_id: "_score_1".into(),
        result_item_name: "积分".into(),
        reasons: reasons.iter().map(|&reason| reason.into()).collect(),
    };
    let path = TempFile::new();
    write(path.path(), &meta, &[chunk(0, records)]);
    analyze_gsr_file(path.path()).unwrap()
}

#[test]
fn percentiles_and_mean_are_exact_near_u64_max() {
    let analysis = analyze_records(&[(0, 0), (u64::MAX - 1, 0), (0, 0), (1, 0)], &["done"]);
    assert_eq!(analysis.values, ["0", "1", "18446744073709551614"]);
    assert_eq!(analysis.cumulative, [0.5, 0.75, 1.0]);
    assert_eq!(analysis.totals.result, "18446744073709551615");
    let stats = analysis.statistic;
    assert_eq!(stats.p5, "0");
    assert_eq!(stats.p25, "0");
    assert_eq!(stats.p50, "0");
    assert_eq!(stats.p75, "4611686018427387904");
    assert_eq!(stats.p95, "15679732462653118872");
    assert_eq!(stats.min, "0");
    assert_eq!(stats.mean, "4611686018427387903");
    assert_eq!(stats.mean_level, 0.75);
    assert_eq!(stats.max, "18446744073709551614");
}

#[test]
fn single_point_distributions_cover_both_u64_boundaries() {
    for value in [0, u64::MAX] {
        let analysis = analyze_records(&[(value, 0)], &["done"]);
        let expected = value.to_string();
        assert_eq!(analysis.cumulative, [1.0]);
        assert_eq!(analysis.values, std::slice::from_ref(&expected));
        let stats = analysis.statistic;
        assert_eq!(
            [
                stats.min, stats.p5, stats.p25, stats.p50, stats.p75, stats.p95, stats.max,
                stats.mean
            ],
            std::array::from_fn(|_| expected.clone())
        );
        assert_eq!(stats.mean_level, 1.0);
    }
}

#[test]
fn reason_shares_rank_remainders_and_break_ties_in_name_order() {
    let analysis = analyze_records(
        &[(0, 3), (0, 1), (0, 0), (0, 3), (0, 1), (0, 0), (0, 3)],
        &["alpha", "café", "unused", "终"],
    );
    assert_eq!(
        analysis.termination_reason,
        [share("alpha", 29), share("café", 28), share("终", 43)]
    );
    assert_eq!(
        analysis
            .termination_reason
            .iter()
            .map(|share| u32::from(share.proportion))
            .sum::<u32>(),
        100
    );
}

#[test]
fn high_cardinality_stops_before_reading_remaining_chunks() {
    let mut stream = GeneratedGsr::new(6_000_000);
    assert!(matches!(
        analyze_gsr_reader(&mut stream),
        Err(GsrError::AnalysisJsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES
        })
    ));
    assert!((3_000_000..4_000_000).contains(&stream.next_run));
    assert!(stream.chunks_emitted < stream.runs.div_ceil(GeneratedGsr::CHUNK_RECORDS));
    assert!(stream.bytes_read < stream.file_size());
    assert!(!stream.trailer_emitted);
}

#[test]
fn duplicate_tail_after_distinct_ten_digit_values_stops_before_tail() {
    // 4.2M distinct 10-digit values already guarantee > 64 MiB compact JSON once
    // nonfinal cumulative probabilities (>= 3 bytes each) are counted.
    let mut stream = GeneratedGsr::with_distinct_prefix(10_000_000, 4_200_000, 1_000_000_000);
    assert!(matches!(
        analyze_gsr_reader(&mut stream),
        Err(GsrError::AnalysisJsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES
        })
    ));
    assert!(
        stream.next_run <= 4_200_000,
        "read into duplicate tail: next_run={}",
        stream.next_run
    );
    assert!(!stream.trailer_emitted);
}

#[test]
fn accepts_a_compact_analysis_between_63_and_64_mib() {
    let mut stream = GeneratedGsr::new(1_890_003);
    let mut analysis = analyze_gsr_reader(&mut stream).unwrap();
    assert_eq!(analysis.values.len() as u64, stream.runs);
    assert_eq!(stream.bytes_read, stream.file_size());
    assert!(stream.trailer_emitted);
    assert!(stream.eof_checked);
    // Appending 1 MiB of unescaped ASCII adds exactly 1 MiB to compact JSON.
    // Crossing the exact validation limit then proves the original exceeded 63 MiB.
    analysis.result_item.name.push_str(&"x".repeat(1024 * 1024));
    assert!(matches!(
        analysis.validate(),
        Err(AnalysisValidationError::JsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES
        })
    ));
}

#[test]
fn observed_reasons_stop_analysis_before_reading_remaining_chunks() {
    let meta = long_reason_metadata(12);
    let records: Vec<_> = (0..11).map(|reason_index| (0, reason_index)).collect();
    let path = TempFile::new();
    let summary = write(
        path.path(),
        &meta,
        &[chunk(0, &records), chunk(11, &[(0, 0)])],
    );
    let mut stream = File::open(path.path()).unwrap();
    assert!(matches!(
        analyze_gsr_reader(&mut stream),
        Err(GsrError::AnalysisJsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES
        })
    ));
    assert_eq!(
        stream.stream_position().unwrap(),
        summary.file_size - GSR_CHUNK_HEADER_BYTES - GSR_RECORD_BYTES - GSR_TRAILER_BYTES
    );
}

#[test]
fn unused_reasons_do_not_count_toward_the_analysis_limit() {
    let meta = long_reason_metadata(11);
    let path = TempFile::new();
    write(path.path(), &meta, &[chunk(0, &[(0, 0); 11])]);
    let analysis = analyze_gsr_file(path.path()).unwrap();
    assert_eq!(analysis.termination_reason, [share(&meta.reasons[0], 100)]);
}

fn long_reason_metadata(total_runs: u64) -> GsrHeaderMeta {
    GsrHeaderMeta {
        total_runs,
        seed: 0,
        result_item_id: "score".into(),
        result_item_name: "积分".into(),
        // Eleven labels escape to about 66 MiB of JSON from 11 MiB of metadata.
        reasons: (0..11)
            .map(|index| format!("{index:02}{}", "\0".repeat(MAX_STRING_BYTES - 2)))
            .collect(),
    }
}

const PREFIX_BYTES: usize =
    GSR_HEADER_BYTES as usize + "score".len() + "积分".len() + 4 + "done".len();

/// Produces a finite GSR of consecutive distinct values (with an optional
/// duplicate tail) using constant memory.
struct GeneratedGsr {
    header: [u8; PREFIX_BYTES],
    header_read: usize,
    runs: u64,
    distinct_prefix: u64,
    first_value: u64,
    next_run: u64,
    chunk_end: u64,
    chunks_emitted: u64,
    trailer_emitted: bool,
    eof_checked: bool,
    bytes_read: u64,
    section: [u8; GSR_TRAILER_BYTES as usize],
    pending: Range<usize>,
}

impl GeneratedGsr {
    const CHUNK_RECORDS: u64 = 8192;
    const FIRST_VALUE: u64 = 1_000_000_000_000;

    fn new(runs: u64) -> Self {
        Self::with_distinct_prefix(runs, runs, Self::FIRST_VALUE)
    }

    fn with_distinct_prefix(runs: u64, distinct_prefix: u64, first_value: u64) -> Self {
        let mut header: [u8; PREFIX_BYTES] = LARGE_TOTAL[..PREFIX_BYTES].try_into().unwrap();
        header[16..24].copy_from_slice(&runs.to_le_bytes());
        Self {
            header,
            header_read: 0,
            runs,
            distinct_prefix: distinct_prefix.min(runs),
            first_value,
            next_run: 0,
            chunk_end: 0,
            chunks_emitted: 0,
            trailer_emitted: false,
            eof_checked: false,
            bytes_read: 0,
            section: [0; GSR_TRAILER_BYTES as usize],
            pending: 0..0,
        }
    }

    fn file_size(&self) -> u64 {
        PREFIX_BYTES as u64
            + self.runs.div_ceil(Self::CHUNK_RECORDS) * GSR_CHUNK_HEADER_BYTES
            + self.runs * GSR_RECORD_BYTES
            + GSR_TRAILER_BYTES
    }

    fn emit_section(&mut self) {
        let len = if self.next_run < self.runs {
            if self.next_run == self.chunk_end {
                let count = Self::CHUNK_RECORDS.min(self.runs - self.next_run);
                self.section[..8].copy_from_slice(&self.next_run.to_le_bytes());
                self.section[8..16].copy_from_slice(&count.to_le_bytes());
                self.chunk_end += count;
                self.chunks_emitted += 1;
                GSR_CHUNK_HEADER_BYTES
            } else {
                let value = if self.next_run < self.distinct_prefix {
                    self.first_value + self.next_run
                } else {
                    self.first_value
                };
                self.section[..8].copy_from_slice(&value.to_le_bytes());
                self.section[8..12].copy_from_slice(&0u32.to_le_bytes());
                self.next_run += 1;
                GSR_RECORD_BYTES
            }
        } else if !self.trailer_emitted {
            let distinct = self.distinct_prefix;
            let tail = self.runs - distinct;
            let total = distinct * self.first_value
                + distinct * (distinct.saturating_sub(1)) / 2
                + tail * self.first_value;
            let file_size = self.file_size();
            self.section[..8].copy_from_slice(&total.to_le_bytes());
            self.section[8..16].copy_from_slice(&self.chunks_emitted.to_le_bytes());
            self.section[16..24].copy_from_slice(&file_size.to_le_bytes());
            self.trailer_emitted = true;
            GSR_TRAILER_BYTES
        } else {
            self.eof_checked = true;
            0
        };
        self.pending = 0..len as usize;
    }
}

impl Read for GeneratedGsr {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        let read = if self.header_read < self.header.len() {
            let read = (&self.header[self.header_read..]).read(buffer)?;
            self.header_read += read;
            read
        } else {
            if self.pending.is_empty() {
                self.emit_section();
            }
            let read = (&self.section[self.pending.clone()]).read(buffer)?;
            self.pending.start += read;
            read
        };
        self.bytes_read += read as u64;
        Ok(read)
    }
}
