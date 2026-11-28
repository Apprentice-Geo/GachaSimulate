//! Configuration source and installation entry points for the desktop host.

mod download;
mod package;
mod storage;
#[cfg(test)]
#[path = "../tests/support/temp_dir.rs"]
mod temp_dir;

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::path::{self, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};
use std::time::{Duration, Instant};

use gachasimulate_config::read_repository_index;
use gachasimulate_desktop_contract::{
    ConfigRepositoryState, ConfigSnapshotProvider, ConfigSource, DesktopError, DesktopErrorCode,
    InstalledConfig, RepositoryConfig, RepositoryConfigStatus, ResolvedConfigSnapshot,
};
use gachasimulate_types::ConfigRepositoryIndex;
use sha2::{Digest, Sha256};
use url::Url;

use download::{check_size, https_url};
pub use download::{
    ConfigDownloader, HttpsConfigDownloader, CONFIG_DOWNLOAD_TIMEOUT, CONFIG_INDEX_DOWNLOAD_LIMIT,
    CONFIG_REDIRECT_LIMIT, CONFIG_RETRY_AFTER_LIMIT, CONFIG_ZIP_DOWNLOAD_LIMIT,
    OFFICIAL_CONFIG_INDEX_URL,
};
use package::{check_id, extract_zip, read_directory, require_directory, validate_snapshot};
use storage::Storage;

pub const CONFIG_REFRESH_TTL: Duration = Duration::from_secs(300);

pub struct ConfigStoreOptions {
    pub index_url: String,
    pub downloader: Arc<dyn ConfigDownloader>,
    pub simulation_active: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub mutation_gate: Option<Arc<Mutex<()>>>,
    pub now: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for ConfigStoreOptions {
    fn default() -> Self {
        Self {
            index_url: OFFICIAL_CONFIG_INDEX_URL.into(),
            downloader: Arc::new(HttpsConfigDownloader::new()),
            simulation_active: None,
            mutation_gate: None,
            now: Arc::new(Instant::now),
        }
    }
}

/// One store owns a configuration root. Share it between desktop callers.
pub struct ConfigStore {
    storage: Storage,
    options: ConfigStoreOptions,
    operation: Mutex<()>,
    // Readers hold a shared guard through their filesystem reads. Writers
    // acquire the exclusive guard only to publish changes, after staging.
    state: RwLock<State>,
}

#[derive(Default)]
struct State {
    remote: Option<RemoteIndex>,
    source_error: Option<String>,
    refreshed_at: Option<Instant>,
    local_directory: Option<PathBuf>,
}

struct RemoteIndex {
    index: ConfigRepositoryIndex,
    url: Url,
}

impl ConfigStore {
    pub fn new(configs_dir: PathBuf) -> Result<Self, DesktopError> {
        Self::with_options(configs_dir, ConfigStoreOptions::default())
    }

    pub fn with_options(
        configs_dir: PathBuf,
        options: ConfigStoreOptions,
    ) -> Result<Self, DesktopError> {
        let root = path::absolute(&configs_dir).map_err(|error| io_error(&configs_dir, error))?;
        let storage = Storage::new(&root)?;
        let state = State {
            local_directory: storage.local_directory(),
            ..State::default()
        };
        Ok(Self {
            storage,
            options,
            operation: Mutex::new(()),
            state: RwLock::new(state),
        })
    }

    pub fn list_configs(&self) -> Result<Vec<InstalledConfig>, DesktopError> {
        let state = self.read_state()?;
        let mut configs = self.scan_installed()?;
        configs.extend(scan_local(state.local_directory.as_deref()).0);
        Ok(configs)
    }

    pub fn get_config_repository_state(&self) -> Result<ConfigRepositoryState, DesktopError> {
        let state = self.read_state()?;
        let mut installed: BTreeMap<_, _> = self
            .scan_installed()?
            .into_iter()
            .map(|config| (config.id.clone(), config))
            .collect();
        let mut official = Vec::new();
        if let Some(remote) = &state.remote {
            for entry in &remote.index.configs {
                let status = if installed.remove(&entry.id).is_none() {
                    RepositoryConfigStatus::Available
                } else if self.storage.sha256(&entry.id).as_deref() == Some(&entry.sha256) {
                    RepositoryConfigStatus::Installed
                } else {
                    RepositoryConfigStatus::UpdateAvailable
                };
                official.push(RepositoryConfig {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    description: entry.description.clone(),
                    status,
                });
            }
        }
        official.extend(installed.into_values().map(|config| RepositoryConfig {
            id: config.id,
            name: config.name,
            description: config.description,
            status: if state.remote.is_some() {
                RepositoryConfigStatus::Removed
            } else {
                RepositoryConfigStatus::Installed
            },
        }));
        official.sort_unstable_by(|left, right| left.id.cmp(&right.id));
        let (local_configs, local_error) = scan_local(state.local_directory.as_deref());
        Ok(ConfigRepositoryState {
            official,
            local_directory: state
                .local_directory
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned()),
            local_configs,
            source_error: state.source_error.clone(),
            local_error,
        })
    }

    pub fn refresh_config_repository(
        &self,
        force: Option<bool>,
    ) -> Result<ConfigRepositoryState, DesktopError> {
        let _operation = self.begin_operation()?;
        let refreshed_at = self.read_state()?.refreshed_at;
        if force != Some(true)
            && refreshed_at.is_some_and(|time| {
                (self.options.now)().saturating_duration_since(time) < CONFIG_REFRESH_TTL
            })
        {
            return self.get_config_repository_state();
        }

        let remote = (|| {
            let url = https_url(&self.options.index_url)?;
            let (bytes, url) = self.download(&url, CONFIG_INDEX_DOWNLOAD_LIMIT, false)?;
            let json = std::str::from_utf8(&bytes).map_err(|error| {
                repository_error(format!("repository index must be valid UTF-8: {error}"))
            })?;
            let index =
                read_repository_index(json).map_err(|error| repository_error(error.to_string()))?;
            Ok::<_, DesktopError>(RemoteIndex { index, url })
        })();
        {
            let mut state = self.write_state()?;
            match remote {
                Ok(index) => {
                    state.remote = Some(index);
                    state.source_error = None;
                }
                Err(error) => state.source_error = Some(error.message),
            }
            state.refreshed_at = Some((self.options.now)());
        }
        self.get_config_repository_state()
    }

    pub fn install_config(&self, id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        self.install_or_update(id)
    }

    pub fn update_config(&self, id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        self.install_or_update(id)
    }

    pub fn uninstall_config(&self, id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        let _operation = self.begin_change()?;
        check_id(id)?;
        let stage = self.storage.stage()?;
        let result = (|| {
            let _gate = self.lock_mutation()?;
            let _state = self.write_state()?;
            self.storage.uninstall(&stage, id)
        })();
        Storage::finish(&stage, result)?;
        self.get_config_repository_state()
    }

    /// The desktop shell supplies the path from its own directory picker.
    pub fn set_local_config_directory(
        &self,
        directory: &Path,
    ) -> Result<ConfigRepositoryState, DesktopError> {
        let _operation = self.begin_change()?;
        // Trailing slashes and `/.` can make symlink_metadata follow the
        // final link on some platforms. Remove them before checking the path.
        let normalized: PathBuf = directory.components().collect();
        require_directory(&normalized).map_err(|error| {
            DesktopError::new(
                DesktopErrorCode::InvalidRequest,
                format!("{}: {error}", directory.display()),
            )
        })?;
        let directory = path::absolute(&normalized).map_err(|error| io_error(directory, error))?;
        {
            let _gate = self.lock_mutation()?;
            let mut state = self.write_state()?;
            let result = self.storage.set_local_directory(&directory);
            state.local_directory = if result.is_ok() {
                Some(directory)
            } else {
                self.storage.local_directory()
            };
            result?;
        }
        self.get_config_repository_state()
    }

    fn install_or_update(&self, id: &str) -> Result<ConfigRepositoryState, DesktopError> {
        let _operation = self.begin_change()?;
        check_id(id)?;
        let (entry, base) = {
            let state = self.read_state()?;
            state
                .remote
                .as_ref()
                .and_then(|remote| {
                    let entry = remote.index.configs.iter().find(|entry| entry.id == id)?;
                    Some((entry.clone(), remote.url.clone()))
                })
                .ok_or_else(|| {
                    DesktopError::new(
                        DesktopErrorCode::NotFound,
                        "configuration is not present in the official source",
                    )
                })?
        };

        // The index validator has already checked download_url's relative
        // path syntax, including percent-encoded separators and traversals.
        let url = base
            .join(&entry.download_url)
            .map_err(|error| repository_error(format!("invalid package URL: {error}")))?;
        if url.scheme() != "https" || url.origin() != base.origin() {
            return Err(repository_error(
                "package URL must resolve to the HTTPS index origin",
            ));
        }
        let (bytes, _) = self.download(&url, CONFIG_ZIP_DOWNLOAD_LIMIT, true)?;
        if sha256_hex(&bytes) != entry.sha256 {
            return Err(repository_error(
                "configuration package SHA-256 does not match the index",
            ));
        }

        let stage = self.storage.stage()?;
        let result = (|| {
            let staged_config = stage.join(id);
            extract_zip(&bytes, &staged_config)?;
            validate_snapshot(id, ConfigSource::Installed, read_directory(&staged_config)?)?;
            let _gate = self.lock_mutation()?;
            let _state = self.write_state()?;
            self.storage.commit_install(&stage, id, entry.sha256)
        })();
        Storage::finish(&stage, result)?;
        self.get_config_repository_state()
    }

    fn scan_installed(&self) -> Result<Vec<InstalledConfig>, DesktopError> {
        match scan(&self.storage.installed, ConfigSource::Installed) {
            Err(error) if error.code == DesktopErrorCode::NotFound => Ok(Vec::new()),
            result => result,
        }
    }

    fn download(
        &self,
        url: &Url,
        limit: usize,
        same_origin_redirects: bool,
    ) -> Result<(Vec<u8>, Url), DesktopError> {
        let (bytes, resolved) = self.options.downloader.download_resolved(
            url.as_str(),
            limit,
            same_origin_redirects,
        )?;
        check_size(&bytes, limit)?;
        let resolved = https_url(&resolved)?;
        if same_origin_redirects && resolved.origin() != url.origin() {
            return Err(repository_error(
                "configuration redirect must stay on the package origin",
            ));
        }
        Ok((bytes, resolved))
    }

    fn begin_operation(&self) -> Result<MutexGuard<'_, ()>, DesktopError> {
        self.operation.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => DesktopError::new(
                DesktopErrorCode::Conflict,
                "a configuration operation is already running",
            ),
            TryLockError::Poisoned(_) => lock_error(),
        })
    }

    fn begin_change(&self) -> Result<MutexGuard<'_, ()>, DesktopError> {
        let operation = self.begin_operation()?;
        drop(self.lock_mutation()?);
        Ok(operation)
    }

    // The operation guard is already held. Acquire the state write guard
    // only after this check, keeping the gate through publication.
    fn lock_mutation(&self) -> Result<Option<MutexGuard<'_, ()>>, DesktopError> {
        let gate = self
            .options
            .mutation_gate
            .as_ref()
            .map(|gate| gate.lock().map_err(|_| lock_error()))
            .transpose()?;
        self.check_simulation()?;
        Ok(gate)
    }

    fn check_simulation(&self) -> Result<(), DesktopError> {
        if self
            .options
            .simulation_active
            .as_ref()
            .is_some_and(|active| active())
        {
            return Err(DesktopError::new(
                DesktopErrorCode::Conflict,
                "configuration changes are unavailable during simulation",
            ));
        }
        Ok(())
    }

    fn read_state(&self) -> Result<RwLockReadGuard<'_, State>, DesktopError> {
        self.state.read().map_err(|_| lock_error())
    }

    fn write_state(&self) -> Result<RwLockWriteGuard<'_, State>, DesktopError> {
        self.state.write().map_err(|_| lock_error())
    }
}

impl ConfigSnapshotProvider for ConfigStore {
    fn resolve_snapshot(
        &self,
        source: ConfigSource,
        config_id: &str,
    ) -> Result<ResolvedConfigSnapshot, DesktopError> {
        check_id(config_id)?;
        let state = self.read_state()?;
        let root = match source {
            ConfigSource::Installed => {
                if self.storage.has_pending(config_id)? {
                    return Err(DesktopError::new(
                        DesktopErrorCode::Conflict,
                        format!(
                            "configuration {config_id} has a pending transaction that requires recovery"
                        ),
                    ));
                }
                &self.storage.installed
            }
            ConfigSource::Local => state.local_directory.as_ref().ok_or_else(|| {
                DesktopError::new(
                    DesktopErrorCode::NotFound,
                    "local configuration directory is unavailable",
                )
            })?,
        };
        require_directory(root).map_err(|error| io_error(root, error))?;
        let (_, snapshot) =
            validate_snapshot(config_id, source, read_directory(&root.join(config_id))?)?;
        Ok(ResolvedConfigSnapshot {
            source,
            config_id: config_id.into(),
            snapshot,
        })
    }
}

fn scan(root: &Path, source: ConfigSource) -> Result<Vec<InstalledConfig>, DesktopError> {
    require_directory(root).map_err(|error| io_error(root, error))?;
    let mut configs = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| io_error(root, error))? {
        let entry = entry.map_err(|error| io_error(root, error))?;
        let name = entry.file_name();
        let Some(id) = name.to_str().filter(|id| check_id(id).is_ok()) else {
            continue;
        };
        let config =
            read_directory(&entry.path()).and_then(|files| validate_snapshot(id, source, files));
        if let Ok((config, _)) = config {
            configs.push(config);
        }
    }
    configs.sort_unstable_by(|left, right| left.id.cmp(&right.id));
    Ok(configs)
}

fn scan_local(root: Option<&Path>) -> (Vec<InstalledConfig>, Option<String>) {
    match root.map(|root| scan(root, ConfigSource::Local)) {
        Some(Ok(configs)) => (configs, None),
        Some(Err(error)) => (Vec::new(), Some(error.message)),
        None => (Vec::new(), None),
    }
}

fn repository_error(message: impl Into<String>) -> DesktopError {
    DesktopError::new(DesktopErrorCode::Repository, message)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

fn io_error(path: &Path, error: io::Error) -> DesktopError {
    let code = if error.kind() == io::ErrorKind::NotFound {
        DesktopErrorCode::NotFound
    } else {
        DesktopErrorCode::Io
    };
    DesktopError::new(code, format!("{}: {error}", path.display()))
}

fn lock_error() -> DesktopError {
    DesktopError::new(
        DesktopErrorCode::Internal,
        "configuration store lock poisoned",
    )
}
