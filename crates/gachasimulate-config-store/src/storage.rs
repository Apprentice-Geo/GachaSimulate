use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use gachasimulate_desktop_contract::{DesktopError, DesktopErrorCode};
use serde::{Deserialize, Serialize};

use crate::io_error;
use crate::package::{check_id, read_file, require_directory};

const PENDING_METADATA: &str = "install.json";
const UNINSTALL_BACKUP: &str = ".removed";
const SETTINGS_LIMIT: u64 = 1024 * 1024;
static NEXT_STAGING_ID: AtomicU64 = AtomicU64::new(0);

pub(crate) struct Storage {
    pub installed: PathBuf,
    metadata: PathBuf,
    staging: PathBuf,
    settings: PathBuf,
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
}

impl Storage {
    pub(crate) fn new(configs_dir: &Path) -> Result<Self, DesktopError> {
        let storage = Self {
            installed: configs_dir.join("installed"),
            metadata: configs_dir.join("installed-meta"),
            staging: configs_dir.join(".staging"),
            settings: configs_dir.join("local-config.json"),
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
        Self::finish(&stage, result)
    }

    pub(crate) fn sha256(&self, id: &str) -> Option<String> {
        let bytes = read_file(&self.metadata_path(id), SETTINGS_LIMIT).ok()?;
        let metadata: InstallMetadata = serde_json::from_slice(&bytes).ok()?;
        (metadata.id == id && is_sha256(&metadata.sha256)).then_some(metadata.sha256)
    }

    fn metadata_path(&self, id: &str) -> PathBuf {
        self.metadata.join(format!("{id}.json"))
    }

    pub(crate) fn stage(&self) -> Result<PathBuf, DesktopError> {
        fs::create_dir_all(&self.staging)
            .and_then(|()| require_directory(&self.staging))
            .map_err(|error| io_error(&self.staging, error))?;
        loop {
            let sequence = NEXT_STAGING_ID.fetch_add(1, Ordering::Relaxed);
            let path = self
                .staging
                .join(format!("{}-{sequence}", std::process::id()));
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
        let prepared = stage.join(PENDING_METADATA);
        let temporary = stage.join("receipt.json");
        write_json(
            &temporary,
            &InstallMetadata {
                id: id.into(),
                sha256,
            },
        )?;
        move_path(&temporary, &prepared)?;
        let staged = stage.join(id);
        let live = self.installed.join(id);
        let backup = stage.join(format!("backup-{id}"));
        let had_previous = move_if_present(&live, &backup)?;

        if let Err(error) = move_path(&staged, &live) {
            return rollback_error(error, restore_previous(had_previous, &backup, &live), stage);
        }
        if let Err(error) = move_path(&prepared, &self.metadata_path(id)) {
            let restored = move_path(&live, &staged)
                .and_then(|()| restore_previous(had_previous, &backup, &live));
            return rollback_error(error, restored, stage);
        }
        Ok(())
    }

    pub(crate) fn uninstall(&self, id: &str) -> Result<(), DesktopError> {
        let stage = self.stage()?;
        let live = self.installed.join(id);
        let removal = stage.join(UNINSTALL_BACKUP);
        let backup = removal.join(id);
        let metadata = self.metadata_path(id);
        let result = fs::create_dir(&removal)
            .map_err(|error| io_error(&removal, error))
            .and_then(|()| move_if_present(&live, &backup))
            .and_then(|had_previous| match fs::remove_file(&metadata) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
                Err(error) => rollback_error(
                    io_error(&metadata, error),
                    restore_previous(had_previous, &backup, &live),
                    &stage,
                ),
            });
        Self::finish(&stage, result)
    }

    pub(crate) fn finish(
        stage: &Path,
        result: Result<(), DesktopError>,
    ) -> Result<(), DesktopError> {
        if matches!(&result, Err(error) if error.code == DesktopErrorCode::CleanupBlocked) {
            return result;
        }
        // Clear the pending marker first. A partially removed staging tree
        // must never be mistaken for an install that still needs rollback.
        let prepared = stage.join(PENDING_METADATA);
        let cleanup = match fs::remove_file(&prepared) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(io_error(&prepared, error)),
        }
        .and_then(|()| fs::remove_dir_all(stage).map_err(|error| io_error(stage, error)));
        result.and(cleanup)
    }

    fn clean_staging(&self) -> Result<(), DesktopError> {
        match require_directory(&self.staging) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(&self.staging, error)),
        }
        for entry in fs::read_dir(&self.staging).map_err(|error| io_error(&self.staging, error))? {
            let entry = entry.map_err(|error| io_error(&self.staging, error))?;
            let stage = entry.path();
            if require_directory(&stage).is_ok() {
                self.recover_install(&stage)?;
                self.recover_uninstall(&stage)?;
            }
        }
        fs::remove_dir_all(&self.staging).map_err(|error| io_error(&self.staging, error))
    }

    fn recover_install(&self, stage: &Path) -> Result<(), DesktopError> {
        // The pending metadata is prepared before moving any live directory.
        // Its replacement of the per-ID receipt is the commit point.
        let marker = stage.join(PENDING_METADATA);
        let bytes = match read_file(&marker, SETTINGS_LIMIT) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(&marker, error)),
        };
        let InstallMetadata { id, sha256 } = serde_json::from_slice(&bytes).map_err(|error| {
            crate::repository_error(format!("invalid pending install metadata: {error}"))
        })?;
        check_id(&id)?;
        if !is_sha256(&sha256) {
            return Err(crate::repository_error("invalid pending install metadata"));
        }
        let live = self.installed.join(&id);
        let staged = stage.join(&id);
        let backup = stage.join(format!("backup-{id}"));
        if !exists(&staged)? {
            move_if_present(&live, &staged)?;
        }
        move_if_present(&backup, &live)?;
        fs::remove_file(&marker).map_err(|error| io_error(&marker, error))
    }

    fn recover_uninstall(&self, stage: &Path) -> Result<(), DesktopError> {
        let removal = stage.join(UNINSTALL_BACKUP);
        match require_directory(&removal) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(&removal, error)),
        }
        for entry in fs::read_dir(&removal).map_err(|error| io_error(&removal, error))? {
            let entry = entry.map_err(|error| io_error(&removal, error))?;
            let name = entry.file_name();
            let Some(id) = name.to_str() else {
                continue;
            };
            if check_id(id).is_ok() && exists(&self.metadata_path(id))? {
                move_path(&entry.path(), &self.installed.join(id))?;
            }
        }
        Ok(())
    }
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

fn move_if_present(from: &Path, to: &Path) -> Result<bool, DesktopError> {
    let present = exists(from)?;
    if present {
        move_path(from, to)?;
    }
    Ok(present)
}

fn restore_previous(had_previous: bool, backup: &Path, live: &Path) -> Result<(), DesktopError> {
    if had_previous {
        move_path(backup, live)?;
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
