use std::io;

use serde::{de, Deserialize, Deserializer, Serialize};
use thiserror::Error;

use crate::{is_identifier, MAX_ANALYSIS_JSON_BYTES};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Analysis {
    pub result_item: AnalysisResultItem,
    pub totals: AnalysisTotals,
    pub values: Vec<String>,
    pub cumulative: Vec<f64>,
    pub statistic: AnalysisStatistic,
    pub termination_reason: Vec<TerminationReasonShare>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisResultItem {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisTotals {
    pub runs: String,
    pub result: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AnalysisStatistic {
    #[serde(rename = "P5")]
    pub p5: String,
    #[serde(rename = "P25")]
    pub p25: String,
    #[serde(rename = "P50")]
    pub p50: String,
    #[serde(rename = "P75")]
    pub p75: String,
    #[serde(rename = "P95")]
    pub p95: String,
    #[serde(rename = "MIN")]
    pub min: String,
    #[serde(rename = "MEAN")]
    pub mean: String,
    #[serde(rename = "MEAN_LEVEL")]
    pub mean_level: f64,
    #[serde(rename = "MAX")]
    pub max: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminationReasonShare {
    pub reason: String,
    #[serde(deserialize_with = "deserialize_json_u8")]
    pub proportion: u8,
}

fn deserialize_json_u8<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: Deserializer<'de>,
{
    struct Visitor;

    impl de::Visitor<'_> for Visitor {
        type Value = u8;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a non-negative integral JSON number fitting in u8")
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
            u8::try_from(value).map_err(|_| E::custom("integer out of u8 range"))
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
            u8::try_from(value).map_err(|_| E::custom("integer out of u8 range"))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
            if value.is_finite()
                && value.fract() == 0.0
                && (0.0..=f64::from(u8::MAX)).contains(&value)
            {
                Ok(value as u8)
            } else {
                Err(E::custom("expected an integral JSON number fitting in u8"))
            }
        }
    }

    deserializer.deserialize_any(Visitor)
}

#[derive(Debug, Error)]
pub enum AnalysisValidationError {
    #[error("{path}: {message}")]
    InvalidField { path: String, message: &'static str },
    #[error("Analysis JSON exceeds {limit} bytes")]
    JsonSizeExceeded { limit: usize },
    #[error("could not measure Analysis JSON size: {0}")]
    Serialization(#[source] serde_json::Error),
}

fn invalid(path: impl Into<String>, message: &'static str) -> AnalysisValidationError {
    AnalysisValidationError::InvalidField {
        path: path.into(),
        message,
    }
}

fn decimal(value: &str) -> Option<u64> {
    match value.as_bytes() {
        [b'0'] => Some(0),
        [b'1'..=b'9', rest @ ..] if rest.iter().all(u8::is_ascii_digit) => value.parse().ok(),
        _ => None,
    }
}

impl Analysis {
    /// Checks the decoded schema, distribution and reason shares, and compact
    /// UTF-8 JSON size. The analyzer computes the reported statistics.
    pub fn validate(&self) -> Result<(), AnalysisValidationError> {
        if !is_identifier(&self.result_item.id) {
            return Err(invalid("result_item.id", "invalid item identifier"));
        }
        if self.result_item.name.is_empty() {
            return Err(invalid("result_item.name", "must be non-empty"));
        }
        if !matches!(decimal(&self.totals.runs), Some(runs) if runs > 0) {
            return Err(invalid(
                "totals.runs",
                "must be a positive u64 decimal string",
            ));
        }
        if decimal(&self.totals.result).is_none() {
            return Err(invalid(
                "totals.result",
                "must be a canonical u64 decimal string",
            ));
        }

        self.validate_distribution()?;
        for (path, value) in [
            ("statistic.P5", &self.statistic.p5),
            ("statistic.P25", &self.statistic.p25),
            ("statistic.P50", &self.statistic.p50),
            ("statistic.P75", &self.statistic.p75),
            ("statistic.P95", &self.statistic.p95),
            ("statistic.MIN", &self.statistic.min),
            ("statistic.MEAN", &self.statistic.mean),
            ("statistic.MAX", &self.statistic.max),
        ] {
            if decimal(value).is_none() {
                return Err(invalid(path, "must be a canonical u64 decimal string"));
            }
        }
        if !(0.0..=1.0).contains(&self.statistic.mean_level) {
            return Err(invalid("statistic.MEAN_LEVEL", "must be in [0, 1]"));
        }
        self.validate_reason_shares()?;

        let mut size = CompactJsonSize {
            bytes: 0,
            exceeded: false,
        };
        match serde_json::to_writer(&mut size, self) {
            Ok(()) => Ok(()),
            Err(_) if size.exceeded => Err(AnalysisValidationError::JsonSizeExceeded {
                limit: MAX_ANALYSIS_JSON_BYTES,
            }),
            Err(error) => Err(AnalysisValidationError::Serialization(error)),
        }
    }

    fn validate_distribution(&self) -> Result<(), AnalysisValidationError> {
        if self.values.is_empty() || self.values.len() != self.cumulative.len() {
            return Err(invalid(
                "values",
                "values and cumulative must be non-empty and equally long",
            ));
        }
        let mut previous_value = None;
        let mut previous_level = 0.0;
        for (index, (value, &level)) in self.values.iter().zip(&self.cumulative).enumerate() {
            let value = decimal(value).ok_or_else(|| {
                invalid(
                    format!("values[{index}]"),
                    "must be a canonical u64 decimal string",
                )
            })?;
            if previous_value.is_some_and(|previous| previous >= value) {
                return Err(invalid(
                    format!("values[{index}]"),
                    "must strictly increase",
                ));
            }
            if !(level > previous_level && level <= 1.0) {
                return Err(invalid(
                    format!("cumulative[{index}]"),
                    "must strictly increase within (0, 1]",
                ));
            }
            previous_value = Some(value);
            previous_level = level;
        }
        if previous_level != 1.0 {
            return Err(invalid("cumulative", "last probability must equal 1"));
        }
        Ok(())
    }

    fn validate_reason_shares(&self) -> Result<(), AnalysisValidationError> {
        let mut total = 0u32;
        for (index, share) in self.termination_reason.iter().enumerate() {
            if share.reason.is_empty() {
                return Err(invalid(
                    format!("termination_reason[{index}].reason"),
                    "must be non-empty",
                ));
            }
            if share.proportion > 100 {
                return Err(invalid(
                    format!("termination_reason[{index}].proportion"),
                    "must be in [0, 100]",
                ));
            }
            total += u32::from(share.proportion);
            if total > 100 {
                break;
            }
        }
        if total != 100 {
            return Err(invalid("termination_reason", "proportions must sum to 100"));
        }
        Ok(())
    }
}

struct CompactJsonSize {
    bytes: usize,
    exceeded: bool,
}

impl io::Write for CompactJsonSize {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() > MAX_ANALYSIS_JSON_BYTES - self.bytes {
            self.exceeded = true;
            return Err(io::Error::other("Analysis JSON size limit exceeded"));
        }
        self.bytes += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
