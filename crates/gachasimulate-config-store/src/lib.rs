//! Configuration source and installation entry points for the desktop host.

use std::path::Path;

use gachasimulate_desktop_contract::{
    ConfigRepositoryState, ConfigSnapshotProvider, ConfigSource, DesktopError, InstalledConfig,
    ResolvedConfigSnapshot,
};

#[derive(Debug, Default)]
pub struct ConfigStore;

impl ConfigStore {
    pub fn list_configs(&self) -> Result<Vec<InstalledConfig>, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn get_config_repository_state(&self) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn refresh_config_repository(
        &self,
        _force: Option<bool>,
    ) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn install_config(&self, _id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn update_config(&self, _id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    pub fn uninstall_config(&self, _id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }

    /// The desktop shell supplies the path from its own directory picker.
    pub fn set_local_config_directory(
        &self,
        _directory: &Path,
    ) -> Result<ConfigRepositoryState, DesktopError> {
        Err(DesktopError::not_implemented())
    }
}

impl ConfigSnapshotProvider for ConfigStore {
    fn resolve_snapshot(
        &self,
        _source: ConfigSource,
        _config_id: &str,
    ) -> Result<ResolvedConfigSnapshot, DesktopError> {
        Err(DesktopError::not_implemented())
    }
}
