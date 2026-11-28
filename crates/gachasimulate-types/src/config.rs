use serde::{de, Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub const YAML_TEXT_LIMIT: usize = 1024 * 1024;
pub const MANIFEST_FILE: &str = "manifest.yaml";
pub const CONFIG_FILE: &str = "config.yaml";

pub const CONFIG_REPOSITORY_FORMAT_VERSION: u32 = 1;
pub const REPOSITORY_INDEX_TEXT_LIMIT: usize = 1024 * 1024;
pub const REPOSITORY_CONFIG_LIMIT: usize = 1024;
pub const REPOSITORY_ID_BYTE_LIMIT: usize = 64;
pub const REPOSITORY_NAME_BYTE_LIMIT: usize = 256;
pub const REPOSITORY_DESCRIPTION_BYTE_LIMIT: usize = 8 * 1024;
pub const REPOSITORY_TERMINATION_LIMIT: usize = 62;
pub const REPOSITORY_TERMINATION_FILE_BYTE_LIMIT: usize = 255;
pub const REPOSITORY_TERMINATION_NAME_BYTE_LIMIT: usize = 128;
pub const CONFIG_PACKAGE_FILE_LIMIT: usize = 64;
pub const CONFIG_PACKAGE_FILE_SIZE_LIMIT: u64 = YAML_TEXT_LIMIT as u64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigSnapshot {
    pub manifest_yaml: String,
    pub config_yaml: String,
    pub terminations: Vec<TerminationSource>,
}

impl ConfigSnapshot {
    /// Looks up the exact name supplied by the manifest.
    pub fn termination(&self, file: &str) -> Option<&TerminationSource> {
        self.terminations.iter().find(|source| source.file == file)
    }

    pub fn file(&self, file: &str) -> Option<&str> {
        match file {
            MANIFEST_FILE => Some(&self.manifest_yaml),
            CONFIG_FILE => Some(&self.config_yaml),
            _ => self.termination(file).map(|source| source.content.as_str()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminationSource {
    pub file: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPackageFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigPackageBytes {
    pub path: String,
    pub bytes: Vec<u8>,
}

impl ConfigPackageBytes {
    pub fn metadata(&self) -> ConfigPackageFile {
        ConfigPackageFile {
            path: self.path.clone(),
            size: self.bytes.len() as u64,
        }
    }
}

/// Lossless representation of YAML metadata values, including arbitrary-precision
/// integers, verbatim finite floats (such as `1.0e+400`), non-finite floats
/// (`.inf`, `-.inf`, `.nan`), explicit YAML tags (`!!binary`, `!!set`, custom
/// tags), and arbitrary YAML mapping keys that JSON cannot represent directly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum YamlValue {
    Null,
    Bool(bool),
    /// Arbitrary-precision YAML integer stored losslessly as text.
    Integer(String),
    /// Finite YAML floating-point scalar stored verbatim without binary64 rounding.
    Float(String),
    Infinity,
    NegInfinity,
    Nan,
    String(String),
    Sequence(Vec<YamlValue>),
    Mapping(Vec<(YamlValue, YamlValue)>),
    Tagged {
        tag: String,
        value: Box<YamlValue>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub terminations: Vec<ConfigTermination>,
    pub metadata: Option<YamlValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigTermination {
    pub file: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigItem {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{path}: {message}")]
pub struct CompileDiagnostic {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CompileError {
    #[error(transparent)]
    Diagnostic(#[from] CompileDiagnostic),
    #[error("configuration compilation is not implemented")]
    NotImplemented,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("configuration validation failed for {failed_files:?}")]
pub struct BatchValidationError {
    pub failed_files: Vec<String>,
    pub diagnostics: Vec<CompileDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRepositoryIndex {
    #[serde(deserialize_with = "deserialize_json_u32")]
    pub format_version: u32,
    pub configs: Vec<ConfigRepositoryEntry>,
}

fn deserialize_json_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    struct Visitor;

    impl de::Visitor<'_> for Visitor {
        type Value = u32;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a non-negative integral JSON number fitting in u32")
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<Self::Value, E> {
            u32::try_from(value).map_err(|_| E::custom("integer out of u32 range"))
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<Self::Value, E> {
            u32::try_from(value).map_err(|_| E::custom("integer out of u32 range"))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<Self::Value, E> {
            if value.is_finite()
                && value.fract() == 0.0
                && (0.0..=f64::from(u32::MAX)).contains(&value)
            {
                Ok(value as u32)
            } else {
                Err(E::custom("expected an integral JSON number fitting in u32"))
            }
        }
    }

    deserializer.deserialize_any(Visitor)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigRepositoryEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub download_url: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RepositoryError {
    #[error("{path}: {message}")]
    Invalid { path: String, message: String },
    #[error(transparent)]
    Compile(#[from] CompileError),
    #[error("configuration repository validation is not implemented")]
    NotImplemented,
}
