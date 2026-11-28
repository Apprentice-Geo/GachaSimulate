use std::collections::{HashMap, HashSet};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Cursor, Write};
use std::path::Path;

use gachasimulate_config::{compile_snapshot, read_config_items, validate_config_package};
use gachasimulate_desktop_contract::{
    ConfigSource, DesktopError, DesktopErrorCode, InstalledConfig, InstalledTermination,
};
use gachasimulate_types::{
    ConfigPackageBytes, ConfigSnapshot, TerminationSource, CONFIG_FILE, CONFIG_PACKAGE_FILE_LIMIT,
    CONFIG_PACKAGE_FILE_SIZE_LIMIT, MANIFEST_FILE, REPOSITORY_ID_BYTE_LIMIT,
    REPOSITORY_TERMINATION_FILE_BYTE_LIMIT,
};
use zip::ZipArchive;

use crate::{download::read_up_to, io_error, repository_error};

fn safe_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'))
        && bytes.all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
        && !matches!(
            name.as_bytes(),
            b"con"
                | b"prn"
                | b"aux"
                | b"nul"
                | [b'c', b'o', b'm', b'1'..=b'9']
                | [b'l', b'p', b't', b'1'..=b'9']
        )
}

pub(crate) fn check_id(id: &str) -> Result<(), DesktopError> {
    if id.len() > REPOSITORY_ID_BYTE_LIMIT || !safe_name(id) {
        return Err(DesktopError::new(
            DesktopErrorCode::InvalidRequest,
            "invalid configuration id",
        ));
    }
    Ok(())
}

fn check_yaml_name(name: &str) -> Result<(), DesktopError> {
    if name.len() > REPOSITORY_TERMINATION_FILE_BYTE_LIMIT
        || !name.strip_suffix(".yaml").is_some_and(safe_name)
    {
        return Err(repository_error(format!(
            "unsafe configuration file name: {name:?}"
        )));
    }
    Ok(())
}

pub(crate) fn is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT also detects Windows junctions.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.is_symlink()
    }
}

pub(crate) fn require_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_link(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path must be a real directory",
        ));
    }
    Ok(())
}

pub(crate) fn read_file(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    fn regular_file(metadata: &Metadata) -> io::Result<()> {
        if !metadata.is_file() || is_link(metadata) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "path must be a regular file",
            ));
        }
        Ok(())
    }

    let before = fs::symlink_metadata(path)?;
    regular_file(&before)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_OPEN_REPARSE_POINT opens a substituted link itself.
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    regular_file(&opened)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (before.dev(), before.ino()) != (opened.dev(), opened.ino()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "file changed while opening",
            ));
        }
    }
    let bytes = read_up_to(file, limit)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("file exceeds {limit} bytes"),
        ));
    }
    Ok(bytes)
}

pub(crate) fn read_directory(directory: &Path) -> Result<Vec<ConfigPackageBytes>, DesktopError> {
    require_directory(directory).map_err(|error| io_error(directory, error))?;
    let entries = fs::read_dir(directory).map_err(|error| io_error(directory, error))?;
    let mut files = Vec::new();
    for entry in entries {
        if files.len() == CONFIG_PACKAGE_FILE_LIMIT {
            return Err(repository_error("configuration package exceeds 64 files"));
        }
        let entry = entry.map_err(|error| io_error(directory, error))?;
        let path = entry
            .file_name()
            .into_string()
            .map_err(|_| repository_error("configuration file name must be valid UTF-8"))?;
        check_yaml_name(&path)?;
        let file = entry.path();
        let bytes = read_file(&file, CONFIG_PACKAGE_FILE_SIZE_LIMIT)
            .map_err(|error| io_error(&file, error))?;
        files.push(ConfigPackageBytes { path, bytes });
    }
    Ok(files)
}

fn zip_error(error: zip::result::ZipError) -> DesktopError {
    repository_error(format!("invalid configuration ZIP: {error}"))
}

pub(crate) fn extract_zip(bytes: &[u8], directory: &Path) -> Result<(), DesktopError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes)).map_err(zip_error)?;
    if archive.has_duplicate_names() {
        return Err(repository_error(
            "configuration ZIP contains duplicate names",
        ));
    }
    if archive.len() > CONFIG_PACKAGE_FILE_LIMIT {
        return Err(repository_error("configuration ZIP exceeds 64 entries"));
    }

    // Check every name and mode before creating any files on disk.
    let mut names = Vec::with_capacity(archive.len());
    let mut folded = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index_data(index).map_err(zip_error)?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| repository_error("configuration ZIP name must be valid UTF-8"))?;
        if entry.is_dir()
            || entry.is_symlink()
            || entry.unix_mode().is_some_and(|mode| {
                let kind = mode & 0o170000;
                kind != 0 && kind != 0o100000
            })
        {
            return Err(repository_error(format!(
                "configuration ZIP entry is not a regular file: {name:?}"
            )));
        }
        let lower = name.to_ascii_lowercase();
        if !folded.insert(lower) {
            return Err(repository_error(format!(
                "configuration ZIP contains a case-insensitive name collision: {name:?}"
            )));
        }
        names.push(name.to_owned());
    }
    for name in &names {
        check_yaml_name(name)?;
    }

    fs::create_dir(directory).map_err(|error| io_error(directory, error))?;
    for (index, name) in names.iter().enumerate() {
        let entry = archive.by_index(index).map_err(zip_error)?;
        let bytes = read_up_to(entry, CONFIG_PACKAGE_FILE_SIZE_LIMIT).map_err(|error| {
            repository_error(format!("could not extract ZIP entry {name}: {error}"))
        })?;
        if bytes.len() as u64 > CONFIG_PACKAGE_FILE_SIZE_LIMIT {
            return Err(repository_error(format!("ZIP entry {name} exceeds 1 MiB")));
        }
        let path = directory.join(name);
        File::create_new(&path)
            .and_then(|mut file| file.write_all(&bytes))
            .map_err(|error| io_error(&path, error))?;
    }
    Ok(())
}

pub(crate) fn validate_snapshot(
    id: &str,
    source: ConfigSource,
    files: Vec<ConfigPackageBytes>,
) -> Result<(InstalledConfig, ConfigSnapshot), DesktopError> {
    let manifest =
        validate_config_package(id, &files).map_err(|error| repository_error(error.to_string()))?;
    let mut files: HashMap<_, _> = files
        .into_iter()
        .map(|file| (file.path, file.bytes))
        .collect();
    let mut take_text = |name: &str| {
        let bytes = files
            .remove(name)
            .ok_or_else(|| repository_error(format!("missing configuration file: {name}")))?;
        String::from_utf8(bytes)
            .map_err(|_| repository_error(format!("{name} must be valid UTF-8")))
    };
    let manifest_yaml = take_text(MANIFEST_FILE)?;
    let config_yaml = take_text(CONFIG_FILE)?;
    let mut terminations = Vec::with_capacity(manifest.terminations.len());
    let mut installed_terminations = Vec::with_capacity(manifest.terminations.len());
    for term in manifest.terminations {
        let content = match term.file.as_str() {
            MANIFEST_FILE => manifest_yaml.clone(),
            CONFIG_FILE => config_yaml.clone(),
            name => take_text(name)?,
        };
        terminations.push(TerminationSource {
            file: term.file.clone(),
            content,
        });
        installed_terminations.push(InstalledTermination {
            file: term.file,
            name: term.name,
        });
    }
    let snapshot = ConfigSnapshot {
        manifest_yaml,
        config_yaml,
        terminations,
    };
    let items = read_config_items(&snapshot.config_yaml)
        .map_err(|error| DesktopError::new(DesktopErrorCode::Compile, error.to_string()))?;
    // A compiled program requires a result item. Any declared item validates
    // the same program invariants, independently of the user's eventual selection.
    for term in &snapshot.terminations {
        compile_snapshot(&snapshot, &term.file, &items[0].id).map_err(|error| {
            DesktopError::new(DesktopErrorCode::Compile, format!("{}: {error}", term.file))
        })?;
    }
    let config = InstalledConfig {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        source,
        terminations: installed_terminations,
        items,
    };
    Ok((config, snapshot))
}
