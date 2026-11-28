use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
};

pub(crate) fn unique_id() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = u128::from_be_bytes(bytes);
    Ok(format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        hex >> 96,
        (hex >> 80) & 0xffff,
        (hex >> 64) & 0xffff,
        (hex >> 48) & 0xffff,
        hex & 0xffff_ffff_ffff,
    ))
}

pub(crate) fn sidecar_path(gsr: &Path) -> PathBuf {
    gsr.with_extension("visualize.json")
}

pub(crate) fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Serialize GSR replacement with sidecar reads and commits. Result sessions
/// pin the revision they analyzed so they cannot attach edits to an overwrite.
#[derive(Default)]
pub(crate) struct ResultFiles {
    revisions: HashMap<PathBuf, Weak<AtomicBool>>,
}

impl ResultFiles {
    pub(crate) fn revision(&mut self, gsr: &Path) -> Arc<AtomicBool> {
        if let Some(revision) = self.revisions.get(gsr).and_then(Weak::upgrade) {
            return revision;
        }
        self.revisions
            .retain(|_, revision| revision.strong_count() != 0);
        let revision = Arc::new(AtomicBool::new(true));
        self.revisions
            .insert(gsr.to_owned(), Arc::downgrade(&revision));
        revision
    }

    pub(crate) fn replace_gsr(&mut self, temp: &Path, final_path: &Path) -> io::Result<()> {
        let old_path = fs::canonicalize(final_path).ok();
        let sidecar = sidecar_path(final_path);
        let backup = match fs::symlink_metadata(&sidecar) {
            Ok(meta) if meta.is_dir() => {
                return Err(io::Error::other("Result sidecar path is a directory"));
            }
            Ok(_) => {
                // Stage the old sidecar so a failed GSR replacement can restore it.
                let backup = sidecar.with_file_name(format!(".sidecar-{}.tmp", unique_id()?));
                fs::rename(&sidecar, &backup)?;
                Some(backup)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        if let Err(error) = fs::rename(temp, final_path) {
            if let Some(backup) = backup {
                fs::rename(&backup, &sidecar).map_err(|restore| {
                    io::Error::other(format!(
                    "Could not replace GSR: {error}. Could not restore sidecar from {}: {restore}",
                    backup.display()
                ))
                })?;
            }
            return Err(error);
        }

        if let Some(revision) = old_path
            .as_ref()
            .and_then(|path| self.revisions.remove(path))
            .and_then(|weak| weak.upgrade())
        {
            revision.store(false, Ordering::Relaxed);
        }
        if let Some(backup) = backup {
            // The replacement is already committed and the backup has no live
            // sidecar name. A newly acquired external lock cannot undo it.
            let _ = remove_if_present(&backup);
        }
        Ok(())
    }
}

pub(crate) fn save_temp_path(sidecar: &Path) -> io::Result<PathBuf> {
    let suffix = format!(".{}.tmp", unique_id()?);
    let filename = sidecar
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::other("Invalid sidecar filename"))?;
    // The final sidecar may already use the full filename component budget.
    let budget = 255 - suffix.len();
    let prefix = &filename[..filename.floor_char_boundary(budget.min(filename.len()))];
    Ok(sidecar.with_file_name(format!("{prefix}{suffix}")))
}
