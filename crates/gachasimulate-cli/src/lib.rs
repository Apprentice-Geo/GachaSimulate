use std::{
    fs::{self, File},
    io::{Cursor, Read},
    path::Path,
};

use gachasimulate_config::{
    compile_snapshot, read_repository_index, validate_config_package, ConfigManifest,
    ConfigPackageBytes, ConfigRepositoryIndex, ConfigSnapshot, TerminationSource, CONFIG_FILE,
    CONFIG_PACKAGE_FILE_LIMIT, CONFIG_PACKAGE_FILE_SIZE_LIMIT, MANIFEST_FILE,
};
use gachasimulate_gsr::{
    analyze_gsr_file, Analysis, GsrFileWriter, GsrHeaderMeta, GsrWriteSummary,
};
use gachasimulate_runtime::{simulate_to_writer, CancelToken, SimulationOptions};
use zip::ZipArchive;

/// Loads a config package ZIP archive into a single in-memory snapshot and
/// validates it with `gachasimulate_config::validate_config_package`.
pub fn load_package_zip_snapshot(
    directory_id: &str,
    zip_bytes: &[u8],
) -> Result<(ConfigManifest, ConfigSnapshot), String> {
    let mut archive = ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|error| format!("invalid zip archive: {error}"))?;
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

/// Loads a directory containing `manifest.yaml`, `config.yaml`, and
/// `termination*.yaml` into a single `ConfigSnapshot`.
pub fn load_directory_snapshot(dir: &Path) -> Result<ConfigSnapshot, String> {
    let manifest_yaml = fs::read_to_string(dir.join(MANIFEST_FILE)).map_err(|error| {
        format!(
            "failed to read {}: {error}",
            dir.join(MANIFEST_FILE).display()
        )
    })?;
    let config_yaml = fs::read_to_string(dir.join(CONFIG_FILE)).map_err(|error| {
        format!(
            "failed to read {}: {error}",
            dir.join(CONFIG_FILE).display()
        )
    })?;
    let mut terminations = Vec::new();
    for entry in
        fs::read_dir(dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))?
    {
        let entry = entry.map_err(|error| format!("failed to read entry: {error}"))?;
        if !entry
            .file_type()
            .map_err(|error| format!("failed to inspect entry: {error}"))?
            .is_file()
        {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "non-UTF-8 file name".to_string())?;
        if name == MANIFEST_FILE || name == CONFIG_FILE {
            continue;
        }
        let content = fs::read_to_string(entry.path())
            .map_err(|error| format!("failed to read {name}: {error}"))?;
        terminations.push(TerminationSource {
            file: name,
            content,
        });
    }
    terminations.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(ConfigSnapshot {
        manifest_yaml,
        config_yaml,
        terminations,
    })
}

/// Executes the full compile -> simulate -> write GSR v3 -> reopen & analyze pipeline.
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
    let writer = GsrFileWriter::create(gsr_path, &meta)
        .map_err(|error| format!("failed to create GSR: {error}"))?;
    let summary = simulate_to_writer(&program, options, &CancelToken::new(), writer, |_| {})
        .map_err(|error| format!("simulation failed: {error}"))?;
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

pub fn read_file_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let mut file =
        File::open(path).map_err(|error| format!("failed to open {}: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    Ok(bytes)
}
