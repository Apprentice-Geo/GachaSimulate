use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::{ConfigItem, ConfigSnapshot, DesktopError, TerminationSource};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSource {
    Installed,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledTermination {
    pub file: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: ConfigSource,
    pub terminations: Vec<InstalledTermination>,
    #[serde(with = "config_items")]
    pub items: Vec<ConfigItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryConfigStatus {
    Available,
    Installed,
    UpdateAvailable,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub status: RepositoryConfigStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfigRepositoryState {
    pub official: Vec<RepositoryConfig>,
    pub local_directory: Option<String>,
    pub local_configs: Vec<InstalledConfig>,
    pub source_error: Option<String>,
    pub local_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedConfigSnapshot {
    pub source: ConfigSource,
    pub config_id: String,
    #[serde(with = "ConfigSnapshotWire")]
    pub snapshot: ConfigSnapshot,
}

/// 2C reads one complete in-memory snapshot for the requested (source, config_id).
/// 2B validates the selected termination and result item, compiles and runs
/// entirely from that snapshot. Neither the host nor the worker reopens YAML
/// during those operations.
pub trait ConfigSnapshotProvider: Send + Sync {
    fn resolve_snapshot(
        &self,
        source: ConfigSource,
        config_id: &str,
    ) -> Result<ResolvedConfigSnapshot, DesktopError>;
}

#[derive(Serialize, Deserialize)]
#[serde(
    remote = "ConfigSnapshot",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) struct ConfigSnapshotWire {
    manifest_yaml: String,
    config_yaml: String,
    #[serde(with = "termination_sources")]
    terminations: Vec<TerminationSource>,
}

mod config_items {
    use super::*;

    #[derive(Serialize, Deserialize)]
    #[serde(remote = "ConfigItem", deny_unknown_fields)]
    struct ItemWire {
        id: String,
        name: String,
    }

    #[derive(Serialize)]
    #[serde(transparent)]
    struct ItemRef<'a>(#[serde(with = "ItemWire")] &'a ConfigItem);

    #[derive(Deserialize)]
    #[serde(transparent)]
    struct Item(#[serde(with = "ItemWire")] ConfigItem);

    pub(super) fn serialize<S: Serializer>(
        items: &[ConfigItem],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(items.iter().map(ItemRef))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<ConfigItem>, D::Error> {
        Ok(Vec::<Item>::deserialize(deserializer)?
            .into_iter()
            .map(|item| item.0)
            .collect())
    }
}

mod termination_sources {
    use super::*;

    #[derive(Serialize, Deserialize)]
    #[serde(remote = "TerminationSource", deny_unknown_fields)]
    struct TerminationWire {
        file: String,
        content: String,
    }

    #[derive(Serialize)]
    #[serde(transparent)]
    struct TerminationRef<'a>(#[serde(with = "TerminationWire")] &'a TerminationSource);

    #[derive(Deserialize)]
    #[serde(transparent)]
    struct Termination(#[serde(with = "TerminationWire")] TerminationSource);

    pub(super) fn serialize<S: Serializer>(
        sources: &[TerminationSource],
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(sources.iter().map(TerminationRef))
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Vec<TerminationSource>, D::Error> {
        Ok(Vec::<Termination>::deserialize(deserializer)?
            .into_iter()
            .map(|source| source.0)
            .collect())
    }
}
