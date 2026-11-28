use std::io::{self, Write};

use serde::{de, Deserialize, Deserializer, Serialize};

use crate::simulation::{deserialize_object_only, safe_filename};
use crate::{Analysis, DesktopError, DesktopErrorCode};

pub const DISPLAY_CONFIG_VERSION: u32 = 2;
pub const DISPLAY_CONFIG_JSON_BYTE_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DisplayFields {
    pub title: String,
    pub target: String,
    pub result_item_name: String,
    pub note: String,
    pub subtitle: String,
    pub result_item_unit: String,
}

impl<'de> Deserialize<'de> for DisplayFields {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", deny_unknown_fields)]
        struct Fields {
            title: String,
            target: String,
            result_item_name: String,
            note: String,
            subtitle: String,
            result_item_unit: String,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            title: fields.title,
            target: fields.target,
            result_item_name: fields.result_item_name,
            note: fields.note,
            subtitle: fields.subtitle,
            result_item_unit: fields.result_item_unit,
        })
    }
}

/// Uses the published DisplayConfig sidecar field names on disk and over IPC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub struct DisplayConfig {
    #[serde(deserialize_with = "deserialize_version")]
    pub display_version: u32,
    pub title: String,
    pub target: String,
    pub result_item_name: String,
    pub note: String,
    pub subtitle: String,
    pub result_item_unit: String,
}

impl DisplayConfig {
    pub fn for_missing_sidecar(result_item_name: impl Into<String>) -> Self {
        Self {
            display_version: DISPLAY_CONFIG_VERSION,
            title: "标题待填写".into(),
            target: "目标待填写".into(),
            result_item_name: result_item_name.into(),
            note: "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。".into(),
            subtitle: "副标题待填写".into(),
            result_item_unit: String::new(),
        }
    }

    pub fn from_fields(fields: DisplayFields) -> Self {
        Self {
            display_version: DISPLAY_CONFIG_VERSION,
            title: fields.title,
            target: fields.target,
            result_item_name: fields.result_item_name,
            note: fields.note,
            subtitle: fields.subtitle,
            result_item_unit: fields.result_item_unit,
        }
    }

    pub fn fields(&self) -> DisplayFields {
        DisplayFields {
            title: self.title.clone(),
            target: self.target.clone(),
            result_item_name: self.result_item_name.clone(),
            note: self.note.clone(),
            subtitle: self.subtitle.clone(),
            result_item_unit: self.result_item_unit.clone(),
        }
    }

    /// Validates the fields and the size of the compact UTF-8 JSON to be saved.
    pub fn validate(&self) -> Result<(), DesktopError> {
        self.validate_fields()?;
        serde_json::to_writer(ByteCounter::default(), self).map_err(sidecar_error)
    }

    /// Pass the original file bytes so whitespace and JSON escapes count
    /// toward the same size limit applied when reading sidecars.
    pub fn from_sidecar_json(bytes: &[u8]) -> Result<Self, DesktopError> {
        if bytes.len() > DISPLAY_CONFIG_JSON_BYTE_LIMIT {
            return Err(sidecar_error("DisplayConfig sidecar exceeds 16 MiB"));
        }
        if bytes
            .iter()
            .find(|byte| !matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
            != Some(&b'{')
        {
            return Err(sidecar_error("DisplayConfig sidecar must be a JSON object"));
        }
        let display: Self = serde_json::from_slice(bytes).map_err(sidecar_error)?;
        display.validate_fields()?;
        Ok(display)
    }

    fn validate_fields(&self) -> Result<(), DesktopError> {
        if self.display_version != DISPLAY_CONFIG_VERSION {
            return Err(sidecar_error("display_version must be 2"));
        }
        if self.result_item_name.is_empty() {
            return Err(sidecar_error("result_item_name must be non-empty"));
        }
        Ok(())
    }
}

fn sidecar_error(error: impl ToString) -> DesktopError {
    DesktopError::new(DesktopErrorCode::Sidecar, error.to_string())
}

fn deserialize_version<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    // JSON Schema treats 2 and 2.0 as the same integer.
    let number = f64::deserialize(deserializer)?;
    if number.fract() == 0.0 && (0.0..=f64::from(u32::MAX)).contains(&number) {
        Ok(number as u32)
    } else {
        Err(de::Error::custom(
            "display_version must be an unsigned integer",
        ))
    }
}

#[derive(Default)]
struct ByteCounter(usize);

impl Write for ByteCounter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > DISPLAY_CONFIG_JSON_BYTE_LIMIT - self.0 {
            return Err(io::Error::other("DisplayConfig sidecar exceeds 16 MiB"));
        }
        self.0 += bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A candidate leaves the existing active result intact until the frontend
/// builds curve data and confirms this session ID.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultCandidateSession {
    pub session_id: String,
    pub filename: String,
    pub fields: DisplayFields,
    pub analysis: Analysis,
    pub display: DisplayConfig,
}

impl ResultCandidateSession {
    pub fn validate(&self) -> Result<(), DesktopError> {
        if self.session_id.is_empty() || !safe_filename(&self.filename) {
            return Err(DesktopError::invalid_request(
                "Invalid result candidate identity",
            ));
        }
        self.analysis
            .validate()
            .map_err(|error| DesktopError::new(DesktopErrorCode::Analysis, error.to_string()))?;
        self.display.validate()?;
        if self.fields != self.display.fields() {
            return Err(DesktopError::invalid_request(
                "Result candidate fields differ from display",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmResultSessionRequest {
    pub session_id: String,
}

impl<'de> Deserialize<'de> for ConfirmResultSessionRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            session_id: String,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            session_id: fields.session_id,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmResultSessionResponse {
    pub confirmed: bool,
    pub active_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResultFieldsRequest {
    pub session_id: String,
    pub fields: DisplayFields,
}

impl<'de> Deserialize<'de> for SaveResultFieldsRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            session_id: String,
            fields: DisplayFields,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            session_id: fields.session_id,
            fields: fields.fields,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedResultFields {
    pub session_id: String,
    pub display: DisplayConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscardResultDraftRequest {
    pub session_id: String,
}

impl<'de> Deserialize<'de> for DiscardResultDraftRequest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Fields {
            session_id: String,
        }

        let fields: Fields = deserialize_object_only(deserializer)?;
        Ok(Self {
            session_id: fields.session_id,
        })
    }
}
