use std::{
    fmt::Write as _,
    fs::{self, File},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use gachasimulate_config::{
    compile_snapshot, read_config_manifest, read_repository_index, validate_config_package,
    ConfigManifest, ConfigPackageBytes, ConfigRepositoryIndex, ConfigSnapshot, TerminationSource,
    CONFIG_FILE, CONFIG_PACKAGE_FILE_LIMIT, CONFIG_PACKAGE_FILE_SIZE_LIMIT, MANIFEST_FILE,
};
use gachasimulate_gsr::{
    analyze_gsr_file, Analysis, GsrFileWriter, GsrHeaderMeta, GsrWriteSummary,
};
use gachasimulate_runtime::{simulate_to_writer, CancelToken, SimulationOptions};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

pub const MAX_PACKAGE_ARCHIVE_BYTES: usize = 8 * 1024 * 1024;
const UNIX_FILE_TYPE_MASK: u32 = 0o170000;
const UNIX_REGULAR_FILE: u32 = 0o100000;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Reads a compressed package archive with a strict 8 MiB ceiling before
/// buffering into memory.
pub fn read_bounded_archive(path: &Path) -> Result<Vec<u8>, String> {
    let file =
        File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take((MAX_PACKAGE_ARCHIVE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes.len() > MAX_PACKAGE_ARCHIVE_BYTES {
        return Err(format!(
            "{} exceeds compressed archive limit of {} bytes",
            path.display(),
            MAX_PACKAGE_ARCHIVE_BYTES
        ));
    }
    Ok(bytes)
}

/// Loads a config package ZIP archive into a single in-memory snapshot and
/// validates it with `gachasimulate_config::validate_config_package`.
pub fn load_package_zip_snapshot(
    directory_id: &str,
    zip_bytes: &[u8],
) -> Result<(ConfigManifest, ConfigSnapshot), String> {
    if zip_bytes.len() > MAX_PACKAGE_ARCHIVE_BYTES {
        return Err(format!(
            "zip archive exceeds limit of {MAX_PACKAGE_ARCHIVE_BYTES} bytes"
        ));
    }
    let mut archive = ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|error| format!("invalid zip archive: {error}"))?;
    if archive.has_duplicate_names() {
        return Err("zip archive contains duplicate entry names".to_string());
    }
    if archive.len() > CONFIG_PACKAGE_FILE_LIMIT {
        return Err(format!(
            "zip archive contains {} entries, exceeding limit {}",
            archive.len(),
            CONFIG_PACKAGE_FILE_LIMIT
        ));
    }
    let mut package_bytes = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("failed to read zip entry {index}: {error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("invalid zip entry name at {index}: {error}"))?
            .into_owned();
        if entry.is_dir() || entry.is_symlink() || !entry.is_file() {
            return Err(format!("zip entry {name} is not a regular file"));
        }
        if let Some(mode) = entry.unix_mode() {
            let file_type = mode & UNIX_FILE_TYPE_MASK;
            if file_type != 0 && file_type != UNIX_REGULAR_FILE {
                return Err(format!(
                    "zip entry {name} has non-regular file mode {mode:#o}"
                ));
            }
        }
        let mut bytes = Vec::new();
        entry
            .take(CONFIG_PACKAGE_FILE_SIZE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("failed to read zip entry {name}: {error}"))?;
        if bytes.len() as u64 > CONFIG_PACKAGE_FILE_SIZE_LIMIT {
            return Err(format!("zip entry {name} exceeds 1 MiB"));
        }
        package_bytes.push(ConfigPackageBytes { path: name, bytes });
    }

    let manifest = validate_config_package(directory_id, &package_bytes)
        .map_err(|error| format!("package contract rejected {directory_id}: {error}"))?;

    let find_text = |target: &str| -> Result<String, String> {
        let file = package_bytes
            .iter()
            .find(|entry| entry.path == target)
            .ok_or_else(|| format!("missing {target} in validated package"))?;
        String::from_utf8(file.bytes.clone())
            .map_err(|error| format!("{target} is not valid UTF-8: {error}"))
    };

    let manifest_yaml = find_text(MANIFEST_FILE)?;
    let config_yaml = find_text(CONFIG_FILE)?;
    let mut terminations = Vec::with_capacity(manifest.terminations.len());
    for termination in &manifest.terminations {
        terminations.push(TerminationSource {
            file: termination.file.clone(),
            content: find_text(&termination.file)?,
        });
    }

    Ok((
        manifest,
        ConfigSnapshot {
            manifest_yaml,
            config_yaml,
            terminations,
        },
    ))
}

/// Loads `manifest.yaml`, `config.yaml`, and only the termination filenames
/// declared by `manifest.yaml` into a single `ConfigSnapshot`. Unrelated files
/// in the directory (such as previous `.gsr` outputs) are ignored.
pub fn load_directory_snapshot(dir: &Path) -> Result<ConfigSnapshot, String> {
    let manifest_yaml = read_bounded_utf8(&dir.join(MANIFEST_FILE))?;
    let manifest = read_config_manifest(&manifest_yaml)
        .map_err(|error| format!("invalid manifest: {error}"))?;
    let config_yaml = read_bounded_utf8(&dir.join(CONFIG_FILE))?;
    let mut terminations = Vec::with_capacity(manifest.terminations.len());
    for entry in &manifest.terminations {
        let content = read_bounded_utf8(&dir.join(&entry.file))?;
        terminations.push(TerminationSource {
            file: entry.file.clone(),
            content,
        });
    }
    Ok(ConfigSnapshot {
        manifest_yaml,
        config_yaml,
        terminations,
    })
}

fn read_bounded_utf8(path: &Path) -> Result<String, String> {
    let file =
        File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(CONFIG_PACKAGE_FILE_SIZE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > CONFIG_PACKAGE_FILE_SIZE_LIMIT {
        return Err(format!("{} exceeds 1 MiB", path.display()));
    }
    String::from_utf8(bytes)
        .map_err(|error| format!("{} is not valid UTF-8: {error}", path.display()))
}

/// Allocates a unique sibling temporary file path in the same directory as `target`.
pub fn allocate_sibling_temp_path(target: &Path, suffix: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("output");
    for _ in 0..10_000 {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let candidate = parent.join(format!(".{stem}.{suffix}-{}-{seq}.tmp", std::process::id()));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "failed to allocate temporary sibling file for {}",
        target.display()
    ))
}

/// Atomically replaces `target` with `temp_path`, cleaning up `temp_path` on error.
pub fn commit_temp_file(temp_path: &Path, target: &Path) -> Result<(), String> {
    if let Err(first_error) = fs::rename(temp_path, target) {
        if target.exists() {
            let backup = allocate_sibling_temp_path(target, "backup")?;
            fs::rename(target, &backup).map_err(|error| {
                let _ = fs::remove_file(temp_path);
                format!("failed to back up existing {}: {error}", target.display())
            })?;
            if let Err(replace_error) = fs::rename(temp_path, target) {
                let _ = fs::rename(&backup, target);
                let _ = fs::remove_file(temp_path);
                return Err(format!(
                    "failed to replace {}: {replace_error}",
                    target.display()
                ));
            }
            let _ = fs::remove_file(&backup);
            return Ok(());
        }
        let _ = fs::remove_file(temp_path);
        return Err(format!(
            "failed to commit {}: {first_error}",
            target.display()
        ));
    }
    Ok(())
}

/// Returns true if two paths refer to the same file on disk.
pub fn paths_refer_to_same_file(a: &Path, b: &Path) -> Result<bool, String> {
    let canon_a = fs::canonicalize(a)
        .map_err(|error| format!("failed to resolve {}: {error}", a.display()))?;
    if !b.exists() {
        let parent_b = b
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let Ok(canon_parent) = fs::canonicalize(parent_b) else {
            return Ok(false);
        };
        let Some(name) = b.file_name() else {
            return Ok(false);
        };
        return Ok(canon_a == canon_parent.join(name));
    }
    let canon_b = fs::canonicalize(b)
        .map_err(|error| format!("failed to resolve {}: {error}", b.display()))?;
    Ok(canon_a == canon_b)
}

/// Executes the full compile -> simulate -> write GSR v3 (via temp sibling) -> reopen & analyze pipeline.
pub fn run_pipeline(
    snapshot: &ConfigSnapshot,
    termination_file: &str,
    result_item: &str,
    options: &SimulationOptions,
    gsr_path: &Path,
) -> Result<(GsrWriteSummary, Analysis), String> {
    let program = compile_snapshot(snapshot, termination_file, result_item)
        .map_err(|error| format!("compile failed: {error}"))?;
    let meta = GsrHeaderMeta::from_program(&program, options)
        .map_err(|error| format!("invalid header metadata: {error}"))?;
    let temp_gsr = allocate_sibling_temp_path(gsr_path, "gsr")?;
    let writer = GsrFileWriter::create(&temp_gsr, &meta)
        .map_err(|error| format!("failed to create temp GSR: {error}"))?;
    let summary = match simulate_to_writer(&program, options, &CancelToken::new(), writer, |_| {}) {
        Ok(summary) => summary,
        Err(error) => {
            let _ = fs::remove_file(&temp_gsr);
            return Err(format!("simulation failed: {error}"));
        }
    };
    commit_temp_file(&temp_gsr, gsr_path)?;
    let analysis =
        analyze_gsr_file(gsr_path).map_err(|error| format!("analysis failed: {error}"))?;
    analysis
        .validate()
        .map_err(|error| format!("invalid analysis output: {error}"))?;
    Ok((summary, analysis))
}

pub fn read_dist_index(dist_dir: &Path) -> Result<ConfigRepositoryIndex, String> {
    let index_text = fs::read_to_string(dist_dir.join("index.json"))
        .map_err(|error| format!("failed to read index.json: {error}"))?;
    read_repository_index(&index_text).map_err(|error| format!("index validation failed: {error}"))
}
