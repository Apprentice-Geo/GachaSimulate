use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use gachasimulate_desktop_contract::{DesktopError, DesktopErrorCode};
use serde::{Deserialize, Serialize};

use crate::io_error;
use crate::package::{check_id, is_link, read_file, require_directory};

const PENDING_INSTALL: &str = ".install.json";
const PENDING_UNINSTALL: &str = ".uninstall.json";
const BACKUP: &str = ".backup";
const REMOVED_RECEIPT: &str = "removed-receipt.json";
const SETTINGS_LIMIT: u64 = 1024 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Storage {
    pub installed: PathBuf,
    metadata: PathBuf,
    staging: PathBuf,
    settings: PathBuf,
    _root_lock: File,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    local_directory: PathBuf,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallMetadata {
    id: String,
    sha256: String,
    // Committed receipts written before transaction tracking remain readable.
    tx_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UninstallMetadata {
    id: String,
    tx_id: String,
    had_receipt: bool,
}

impl Storage {
    pub(crate) fn new(configs_dir: &Path) -> Result<Self, DesktopError> {
        fs::create_dir_all(configs_dir)
            .and_then(|()| require_directory(configs_dir))
            .map_err(|error| io_error(configs_dir, error))?;
        let lock_path = configs_dir.join(".store.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Keep the lock file in place for the lifetime of the open handle.
            options.share_mode(0x3).custom_flags(0x0020_0000);
        }
        let root_lock = options
            .open(&lock_path)
            .map_err(|error| io_error(&lock_path, error))?;
        let lock_metadata = root_lock
            .metadata()
            .map_err(|error| io_error(&lock_path, error))?;
        if !lock_metadata.is_file() || is_link(&lock_metadata) {
            return Err(crate::repository_error(
                "configuration store lock must be a regular file",
            ));
        }
        root_lock.try_lock().map_err(|error| match error {
            TryLockError::WouldBlock => DesktopError::new(
                DesktopErrorCode::Conflict,
                format!(
                    "configuration store is already open at {}",
                    configs_dir.display()
                ),
            ),
            TryLockError::Error(error) => io_error(&lock_path, error),
        })?;

        let storage = Self {
            installed: configs_dir.join("installed"),
            metadata: configs_dir.join("installed-meta"),
            staging: configs_dir.join(".staging"),
            settings: configs_dir.join("local-config.json"),
            _root_lock: root_lock,
        };
        for path in [&storage.installed, &storage.metadata] {
            fs::create_dir_all(path)
                .and_then(|()| require_directory(path))
                .map_err(|error| io_error(path, error))?;
        }
        storage.clean_staging()?;
        Ok(storage)
    }

    pub(crate) fn local_directory(&self) -> Option<PathBuf> {
        let bytes = read_file(&self.settings, SETTINGS_LIMIT).ok()?;
        let settings: Settings = serde_json::from_slice(&bytes).ok()?;
        (!settings.local_directory.as_os_str().is_empty()).then_some(settings.local_directory)
    }

    pub(crate) fn set_local_directory(&self, directory: &Path) -> Result<(), DesktopError> {
        let stage = self.stage()?;
        let temporary = stage.join("settings.json");
        let result = write_json(
            &temporary,
            &Settings {
                local_directory: directory.to_path_buf(),
            },
        )
        .and_then(|()| move_path(&temporary, &self.settings));
        let cleanup = fs::remove_dir_all(&stage).map_err(|error| io_error(&stage, error));
        result.and(cleanup)
    }

    pub(crate) fn sha256(&self, id: &str) -> Option<String> {
        let bytes = read_file(&self.metadata_path(id), SETTINGS_LIMIT).ok()?;
        let metadata: InstallMetadata = serde_json::from_slice(&bytes).ok()?;
        (metadata.id == id && is_sha256(&metadata.sha256)).then_some(metadata.sha256)
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.metadata.join(format!("{id}.json"))
    }

    fn pending_path(&self, id: &str, suffix: &str) -> PathBuf {
        self.metadata.join(format!("{id}{suffix}"))
    }

    pub(crate) fn stage(&self) -> Result<PathBuf, DesktopError> {
        fs::create_dir_all(&self.staging)
            .and_then(|()| require_directory(&self.staging))
            .map_err(|error| io_error(&self.staging, error))?;
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        loop {
            let sequence = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
            let path = self
                .staging
                .join(format!("{}-{time}-{sequence}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => return Ok(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(io_error(&path, error)),
            }
        }
    }

    pub(crate) fn commit_install(
        &self,
        stage: &Path,
        id: &str,
        sha256: String,
    ) -> Result<(), DesktopError> {
        self.before_mutation(id)?;
        let staged = stage.join(id);
        require_directory(&staged).map_err(|error| io_error(&staged, error))?;
        let prepared = self.pending_path(id, PENDING_INSTALL);
        let temporary = stage.join("receipt.json");
        write_json(
            &temporary,
            &InstallMetadata {
                id: id.into(),
                sha256,
                tx_id: Some(stage_id(stage).into()),
            },
        )?;
        move_path(&temporary, &prepared)?;

        let live = self.installed.join(id);
        let result = move_if_present(&live, &stage.join(BACKUP))
            .and_then(|_| move_path(&staged, &live))
            .and_then(|()| move_path(&prepared, &self.metadata_path(id)));
        if let Err(error) = result {
            return rollback_error(error, self.recover_install(id), stage);
        }
        Ok(())
    }

    pub(crate) fn uninstall(&self, stage: &Path, id: &str) -> Result<(), DesktopError> {
        self.before_mutation(id)?;
        let receipt = self.metadata_path(id);
        let had_receipt = match fs::symlink_metadata(&receipt) {
            Ok(metadata) if metadata.is_file() && !is_link(&metadata) => true,
            Ok(_) => {
                return Err(crate::repository_error(
                    "install receipt must be a regular file",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_error(&receipt, error)),
        };
        let temporary = stage.join("uninstall.json");
        let marker = self.pending_path(id, PENDING_UNINSTALL);
        write_json(
            &temporary,
            &UninstallMetadata {
                id: id.into(),
                tx_id: stage_id(stage).into(),
                had_receipt,
            },
        )?;
        move_path(&temporary, &marker)?;

        let result = (|| {
            move_if_present(&self.installed.join(id), &stage.join(BACKUP))?;
            if had_receipt {
                // Keep the unpublished receipt available until the commit point.
                move_path(&receipt, &stage.join(REMOVED_RECEIPT))?;
            }
            fs::remove_file(&marker).map_err(|error| io_error(&marker, error))
        })();
        if let Err(error) = result {
            return rollback_error(error, self.recover_uninstall(id), stage);
        }
        Ok(())
    }

    pub(crate) fn finish(
        stage: &Path,
        result: Result<(), DesktopError>,
    ) -> Result<(), DesktopError> {
        // Once the journal is gone, backup cleanup cannot affect the outcome.
        if !matches!(&result, Err(error) if error.code == DesktopErrorCode::CleanupBlocked) {
            let _ = fs::remove_dir_all(stage);
        }
        result
    }

    fn clean_staging(&self) -> Result<(), DesktopError> {
        // Only the per-ID journal authorizes recovery. Leftover generations in
        // staging can never select or change the live package.
        let entries =
            fs::read_dir(&self.metadata).map_err(|error| io_error(&self.metadata, error))?;
        let mut pending = BTreeSet::new();
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&self.metadata, error))?;
            let name = entry.file_name();
            if let Some(id) = name.to_str().and_then(|name| {
                name.strip_suffix(PENDING_INSTALL)
                    .or_else(|| name.strip_suffix(PENDING_UNINSTALL))
            }) {
                check_id(id)?;
                pending.insert(id.to_owned());
            }
        }
        for id in pending {
            self.recover_pending(&id)?;
        }

        match require_directory(&self.staging) {
            Ok(()) => {
                self.recover_legacy_staging()?;
                let _ = fs::remove_dir_all(&self.staging);
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(&self.staging, error)),
        }
    }

    pub(crate) fn has_pending(&self, id: &str) -> Result<bool, DesktopError> {
        Ok(exists(&self.pending_path(id, PENDING_INSTALL))?
            || exists(&self.pending_path(id, PENDING_UNINSTALL))?)
    }

    fn recover_legacy_staging(&self) -> Result<(), DesktopError> {
        let entries =
            fs::read_dir(&self.staging).map_err(|error| io_error(&self.staging, error))?;
        for entry in entries {
            let entry = entry.map_err(|error| io_error(&self.staging, error))?;
            let stage = entry.path();
            if require_directory(&stage).is_err() {
                continue;
            }
            let legacy_marker = stage.join("install.json");
            let Some(InstallMetadata { id, sha256, tx_id }) = read_pending(&legacy_marker)? else {
                continue;
            };
            if tx_id.is_some() || check_id(&id).is_err() || !is_sha256(&sha256) {
                continue;
            }
            let live = self.installed.join(&id);
            let staged = stage.join(&id);
            let backup = stage.join(format!("backup-{id}"));
            if exists(&backup)? && (!exists(&live)? || self.sha256(&id).as_deref() != Some(&sha256))
            {
                if !exists(&staged)? {
                    move_if_present(&live, &staged)?;
                }
                move_if_present(&backup, &live)?;
            }
            let _ = fs::remove_file(&legacy_marker);
        }
        Ok(())
    }

    fn before_mutation(&self, id: &str) -> Result<(), DesktopError> {
        self.recover_pending(id).map_err(|error| {
            DesktopError::new(
                DesktopErrorCode::Conflict,
                format!("could not recover pending configuration transaction for {id}: {error}"),
            )
        })
    }

    fn recover_pending(&self, id: &str) -> Result<(), DesktopError> {
        self.recover_install(id)?;
        self.recover_uninstall(id)
    }

    fn transaction_stage(&self, tx_id: &str) -> Result<PathBuf, DesktopError> {
        let mut parts = tx_id.split('-');
        if !(0..3).all(|_| {
            parts.next().is_some_and(|part| {
                !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit())
            })
        }) || parts.next().is_some()
        {
            return Err(crate::repository_error(
                "invalid configuration transaction ID",
            ));
        }
        require_directory(&self.staging).map_err(|error| io_error(&self.staging, error))?;
        let stage = self.staging.join(tx_id);
        require_directory(&stage).map_err(|error| io_error(&stage, error))?;
        Ok(stage)
    }

    fn recover_install(&self, id: &str) -> Result<(), DesktopError> {
        let marker = self.pending_path(id, PENDING_INSTALL);
        let Some(InstallMetadata {
            id: owner,
            sha256,
            tx_id,
        }) = read_pending(&marker)?
        else {
            return Ok(());
        };
        if owner != id || !is_sha256(&sha256) {
            return Err(crate::repository_error("invalid pending install metadata"));
        }
        let tx_id =
            tx_id.ok_or_else(|| crate::repository_error("missing install transaction ID"))?;
        let stage = self.transaction_stage(&tx_id)?;
        let live = self.installed.join(id);
        let staged = stage.join(id);
        if !exists(&staged)? {
            move_if_present(&live, &staged)?;
        }
        move_if_present(&stage.join(BACKUP), &live)?;
        fs::remove_file(&marker).map_err(|error| io_error(&marker, error))
    }

    fn recover_uninstall(&self, id: &str) -> Result<(), DesktopError> {
        let marker = self.pending_path(id, PENDING_UNINSTALL);
        let Some(UninstallMetadata {
            id: owner,
            tx_id,
            had_receipt,
        }) = read_pending(&marker)?
        else {
            return Ok(());
        };
        if owner != id {
            return Err(crate::repository_error(
                "invalid pending uninstall metadata",
            ));
        }
        let stage = self.transaction_stage(&tx_id)?;
        move_if_present(&stage.join(BACKUP), &self.installed.join(id))?;
        if had_receipt {
            move_if_present(&stage.join(REMOVED_RECEIPT), &self.metadata_path(id))?;
        }
        fs::remove_file(&marker).map_err(|error| io_error(&marker, error))
    }
}

fn stage_id(stage: &Path) -> &str {
    stage
        .file_name()
        .and_then(|name| name.to_str())
        .expect("generated staging path")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), DesktopError> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        DesktopError::new(DesktopErrorCode::Io, format!("{}: {error}", path.display()))
    })?;
    File::create_new(path)
        .and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .map_err(|error| io_error(path, error))
}

fn read_pending<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>, DesktopError> {
    match read_file(path, SETTINGS_LIMIT) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|error| {
            crate::repository_error(format!(
                "invalid transaction marker {}: {error}",
                path.display()
            ))
        }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error(path, error)),
    }
}

fn exists(path: &Path) -> Result<bool, DesktopError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(path, error)),
    }
}

fn move_path(from: &Path, to: &Path) -> Result<(), DesktopError> {
    fs::rename(from, to).map_err(|error| {
        DesktopError::new(
            DesktopErrorCode::Io,
            format!(
                "could not rename {} to {}: {error}",
                from.display(),
                to.display()
            ),
        )
    })
}

fn move_if_present(from: &Path, to: &Path) -> Result<(), DesktopError> {
    if exists(from)? {
        move_path(from, to)?;
    }
    Ok(())
}

fn rollback_error(
    error: DesktopError,
    restored: Result<(), DesktopError>,
    stage: &Path,
) -> Result<(), DesktopError> {
    match restored {
        Ok(()) => Err(error),
        Err(rollback) => Err(DesktopError::new(
            DesktopErrorCode::CleanupBlocked,
            format!(
                "{error}. Rollback failed: {rollback}. Staging retained at {}",
                stage.display()
            ),
        )),
    }
}

#[cfg(test)]
#[path = "../tests/support/storage_commit.rs"]
mod tests;
