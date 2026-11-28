use std::fmt;
use std::marker::PhantomData;

use gachasimulate_types::REPOSITORY_ID_BYTE_LIMIT;
use serde::{de, Deserialize, Deserializer, Serialize};

use crate::{DesktopError, MAX_RUNS};

pub const MAX_DESKTOP_THREADS: usize = 256;
pub const SIMULATION_EVENT_NAME: &str = "simulation://event";
pub(crate) const MAX_SAFE_JSON_INTEGER: u64 = (1 << 53) - 1;

pub(crate) fn deserialize_object_only<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    struct MapOnly<T>(PhantomData<T>);

    impl<'de, T: Deserialize<'de>> de::Visitor<'de> for MapOnly<T> {
        type Value = T;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a JSON object")
        }

        fn visit_map<A>(self, map: A) -> Result<Self::Value, A::Error>
        where
            A: de::MapAccess<'de>,
        {
            T::deserialize(de::value::MapAccessDeserializer::new(map))
        }
    }

    deserializer.deserialize_map(MapOnly(PhantomData))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationCommandRequest {
    pub config_source: crate::ConfigSource,
    pub config_id: String,
    pub termination: String,
    pub result_item: String,
    pub total_runs: u64,
    pub seed: i64,
    pub threads: usize,
}

impl<'de> Deserialize<'de> for SimulationCommandRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            config_source: crate::ConfigSource,
            config_id: String,
            termination: String,
            result_item: String,
            total_runs: u64,
            seed: i64,
            threads: usize,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            config_source: fields.config_source,
            config_id: fields.config_id,
            termination: fields.termination,
            result_item: fields.result_item,
            total_runs: fields.total_runs,
            seed: fields.seed,
            threads: fields.threads,
        })
    }
}

impl SimulationCommandRequest {
    pub fn validate(&self, max_threads: usize) -> Result<(), DesktopError> {
        let invalid = DesktopError::invalid_request;
        if !(1..=MAX_RUNS).contains(&self.total_runs) {
            return Err(invalid(format!("totalRuns must be in 1..={MAX_RUNS}")));
        }
        let limit = max_threads.min(MAX_DESKTOP_THREADS);
        if !(1..=limit).contains(&self.threads) {
            return Err(invalid(format!("threads must be in 1..={limit}")));
        }
        if !valid_config_id(&self.config_id) {
            return Err(DesktopError::invalid_request("invalid configId"));
        }
        if !safe_filename(&self.termination) {
            return Err(DesktopError::invalid_request(
                "termination must be a safe filename",
            ));
        }
        let mut item = self.result_item.bytes();
        if !matches!(item.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
            || !item.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(DesktopError::invalid_request(
                "resultItem must be an item identifier",
            ));
        }
        if self.seed.unsigned_abs() > MAX_SAFE_JSON_INTEGER {
            return Err(DesktopError::invalid_request(
                "seed must be a JavaScript safe integer",
            ));
        }
        Ok(())
    }
}

fn valid_config_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    id.len() <= REPOSITORY_ID_BYTE_LIMIT
        && matches!(bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        && !windows_device(id)
}

fn windows_device(stem: &str) -> bool {
    let stem = stem.trim_end_matches(' ').to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con" | "prn" | "aux" | "nul" | "conin$" | "conout$"
    ) || matches!(
        stem.strip_prefix("com")
            .or_else(|| stem.strip_prefix("lpt")),
        Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")
    )
}

pub(crate) fn safe_filename(file: &str) -> bool {
    !file.is_empty()
        && !file.ends_with(['.', ' '])
        && !file.chars().any(|c| {
            c <= '\u{1f}' || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
        })
        && !windows_device(file.split('.').next().unwrap_or_default())
}

pub(crate) fn is_u64_decimal(value: &str) -> bool {
    matches!(value.as_bytes(), [b'0'] | [b'1'..=b'9', ..])
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

pub(crate) mod total_result {
    use serde::{de::Error as _, ser::Error as _, Deserialize, Deserializer, Serializer};

    use super::is_u64_decimal;

    const INVALID: &str = "totalResult must be a canonical u64 decimal string";

    pub fn serialize<S: Serializer>(value: &str, serializer: S) -> Result<S::Ok, S::Error> {
        if !is_u64_decimal(value) {
            return Err(S::Error::custom(INVALID));
        }
        serializer.serialize_str(value)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
        let value = String::deserialize(deserializer)?;
        if !is_u64_decimal(&value) {
            return Err(D::Error::custom(INVALID));
        }
        Ok(value)
    }

    pub mod optional {
        use super::*;

        pub fn serialize<S: Serializer>(
            value: &Option<String>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(value) => super::serialize(value, serializer),
                None => serializer.serialize_none(),
            }
        }

        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<String>, D::Error> {
            let value = Option::<String>::deserialize(deserializer)?;
            if value.as_deref().is_some_and(|value| !is_u64_decimal(value)) {
                return Err(D::Error::custom(INVALID));
            }
            Ok(value)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimulationStatus {
    Idle,
    Starting,
    Running,
    Saving,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SimulationStage {
    LoadingConfig,
    Simulating,
    Saving,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationTaskSnapshot {
    pub task_id: Option<u64>,
    pub seq: u64,
    pub status: SimulationStatus,
    pub stage: Option<SimulationStage>,
    pub completed_runs: u64,
    pub total_runs: u64,
    #[serde(default, with = "total_result::optional")]
    pub total_result: Option<String>,
    pub result_filename: Option<String>,
    pub message: Option<String>,
    pub cancel_retryable: bool,
}

impl Default for SimulationTaskSnapshot {
    fn default() -> Self {
        Self {
            task_id: None,
            seq: 0,
            status: SimulationStatus::Idle,
            stage: None,
            completed_runs: 0,
            total_runs: 0,
            total_result: None,
            result_filename: None,
            message: None,
            cancel_retryable: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulationTaskEvent {
    pub task_id: u64,
    pub seq: u64,
    pub snapshot: SimulationTaskSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSimulationRequest {
    pub task_id: u64,
}

impl CancelSimulationRequest {
    pub fn validate(&self) -> Result<(), DesktopError> {
        if !(1..=MAX_SAFE_JSON_INTEGER).contains(&self.task_id) {
            return Err(DesktopError::invalid_request(
                "taskId must be a positive safe integer",
            ));
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for CancelSimulationRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            task_id: u64,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            task_id: fields.task_id,
        })
    }
}
