use std::{
    cmp::Reverse,
    collections::{hash_map::Entry, HashMap},
    io::{self, Read},
    path::Path,
};

use crate::{
    Analysis, AnalysisResultItem, AnalysisStatistic, AnalysisTotals, AnalysisValidationError,
    GsrError, GsrReader, TerminationReasonShare, MAX_ANALYSIS_JSON_BYTES,
};

// Empty distribution and reason arrays, placeholders for ID/name/run count,
// and the shortest possible content for the remaining fields.
const MIN_JSON: &str = concat!(
    r#"{"result_item":{"id":"","name":""},"totals":{"runs":"","result":"0"},"values":[],"cumulative":[],"#,
    r#""statistic":{"P5":"0","P25":"0","P50":"0","P75":"0","P95":"0","MIN":"0","MEAN":"0","MEAN_LEVEL":0,"MAX":"0"},"#,
    r#""termination_reason":[]}"#,
);

pub fn analyze_gsr_file(path: impl AsRef<Path>) -> Result<Analysis, GsrError> {
    analyze(GsrReader::open(path)?)
}

pub fn analyze_gsr_reader<R: Read>(reader: R) -> Result<Analysis, GsrError> {
    analyze(GsrReader::new(reader)?)
}

fn analyze<R: Read>(mut reader: GsrReader<R>) -> Result<Analysis, GsrError> {
    let mut frequencies = HashMap::new();
    let meta = reader.metadata();
    let runs = meta.total_runs;
    let mut reason_counts = vec![0; meta.reasons.len()];
    let mut has_observed_reason = false;
    // Escaping a UTF-8 string can only increase its encoded byte length.
    let mut minimum_json_bytes = MIN_JSON.len()
        + meta.result_item_id.len()
        + meta.result_item_name.len()
        + decimal_digits(runs);

    while let Some(chunk) = reader.next_chunk()? {
        for record in chunk.records {
            let reason_index = record.reason_index as usize;
            if reason_counts[reason_index] == 0 {
                // Each proportion needs at least one digit.
                minimum_json_bytes += usize::from(has_observed_reason)
                    + r#"{"reason":"#.len()
                    + json_string_byte_len(&reader.metadata().reasons[reason_index])
                    + r#","proportion":0}"#.len();
                check_analysis_json_size(minimum_json_bytes)?;
                has_observed_reason = true;
            }
            reason_counts[reason_index] += 1;
            let is_first_value = frequencies.is_empty();
            match frequencies.entry(record.value) {
                Entry::Occupied(mut entry) => *entry.get_mut() += 1,
                Entry::Vacant(entry) => {
                    // Each value needs two quotes around its digits. The first
                    // cumulative probability can be `1` (1 byte); every
                    // additional distinct value guarantees another nonfinal
                    // probability strictly in (0, 1) (at least 3 bytes, e.g.
                    // `0.1`) plus two commas (one in values, one in cumulative).
                    let overhead = if is_first_value { 3 } else { 7 };
                    minimum_json_bytes += decimal_digits(record.value) + overhead;
                    check_analysis_json_size(minimum_json_bytes)?;
                    entry.insert(1);
                }
            }
        }
    }

    let total_result = reader.total_result();
    let meta = reader.into_metadata();
    let mean = total_result / runs;
    let mut sorted: Vec<(u64, u64)> = frequencies.into_iter().collect();
    sorted.sort_unstable_by_key(|&(value, _)| value);
    let mut values = Vec::with_capacity(sorted.len());
    let mut cumulative = Vec::with_capacity(sorted.len());
    let mut cumulative_count = 0;
    let mut mean_count = 0;
    for (value, count) in &mut sorted {
        cumulative_count += *count;
        *count = cumulative_count;
        if *value <= mean {
            mean_count = cumulative_count;
        }
        values.push(value.to_string());
        cumulative.push(level(cumulative_count, runs));
    }
    *cumulative.last_mut().unwrap() = 1.0;
    let analysis = Analysis {
        result_item: AnalysisResultItem {
            id: meta.result_item_id,
            name: meta.result_item_name,
        },
        totals: AnalysisTotals {
            runs: runs.to_string(),
            result: total_result.to_string(),
        },
        values,
        cumulative,
        statistic: AnalysisStatistic {
            p5: percentile(&sorted, runs, 5).to_string(),
            p25: percentile(&sorted, runs, 25).to_string(),
            p50: percentile(&sorted, runs, 50).to_string(),
            p75: percentile(&sorted, runs, 75).to_string(),
            p95: percentile(&sorted, runs, 95).to_string(),
            min: sorted.first().unwrap().0.to_string(),
            mean: mean.to_string(),
            mean_level: level(mean_count, runs),
            max: sorted.last().unwrap().0.to_string(),
        },
        termination_reason: reason_shares(meta.reasons, reason_counts, runs),
    };
    analysis.validate().map_err(|error| match error {
        AnalysisValidationError::JsonSizeExceeded { limit } => {
            GsrError::AnalysisJsonSizeExceeded { limit }
        }
        error => GsrError::Io(io::Error::new(io::ErrorKind::InvalidData, error)),
    })?;
    Ok(analysis)
}

fn check_analysis_json_size(bytes: usize) -> Result<(), GsrError> {
    if bytes > MAX_ANALYSIS_JSON_BYTES {
        return Err(GsrError::AnalysisJsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES,
        });
    }
    Ok(())
}

fn json_string_byte_len(value: &str) -> usize {
    2 + value
        .bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 0x08 | b'\t' | b'\n' | 0x0c | b'\r' => 2,
            0x00..=0x1f => 6,
            _ => 1,
        })
        .sum::<usize>()
}

fn decimal_digits(value: u64) -> usize {
    value.checked_ilog10().unwrap_or(0) as usize + 1
}

fn level(count: u64, runs: u64) -> f64 {
    count as f64 / runs as f64
}

fn percentile(cumulative_counts: &[(u64, u64)], runs: u64, p: u128) -> u64 {
    let numerator = u128::from(runs - 1) * p;
    let lower_index = (numerator / 100) as u64;
    let upper_index = (lower_index + 1).min(runs - 1);
    let value_at = |index| {
        let position = cumulative_counts.partition_point(|&(_, count)| count <= index);
        cumulative_counts[position].0
    };
    let lower = value_at(lower_index);
    let upper = value_at(upper_index);
    lower + (u128::from(upper - lower) * (numerator % 100) / 100) as u64
}

fn reason_shares(reasons: Vec<String>, counts: Vec<u64>, runs: u64) -> Vec<TerminationReasonShare> {
    let mut shares = Vec::new();
    let mut remainders = Vec::new();
    let mut points_left = 100;
    for (reason, count) in reasons
        .into_iter()
        .zip(counts)
        .filter(|&(_, count)| count > 0)
    {
        let product = u128::from(count) * 100;
        let proportion = (product / u128::from(runs)) as u8;
        let remainder = (product % u128::from(runs)) as u64;
        remainders.push((Reverse(remainder), shares.len()));
        points_left -= proportion;
        shares.push(TerminationReasonShare { reason, proportion });
    }
    // Share indices are in ascending reason name order.
    remainders.sort_unstable();
    for (_, index) in remainders.into_iter().take(usize::from(points_left)) {
        shares[index].proportion += 1;
    }
    shares
}
