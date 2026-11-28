use std::borrow::Cow;
use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::source::trim;
use crate::{
    read_config_manifest, ConfigManifest, ConfigPackageBytes, ConfigRepositoryEntry,
    ConfigRepositoryIndex, RepositoryError, CONFIG_FILE, CONFIG_PACKAGE_FILE_LIMIT,
    CONFIG_PACKAGE_FILE_SIZE_LIMIT, CONFIG_REPOSITORY_FORMAT_VERSION, MANIFEST_FILE,
    REPOSITORY_CONFIG_LIMIT, REPOSITORY_DESCRIPTION_BYTE_LIMIT, REPOSITORY_ID_BYTE_LIMIT,
    REPOSITORY_INDEX_TEXT_LIMIT, REPOSITORY_NAME_BYTE_LIMIT,
    REPOSITORY_TERMINATION_FILE_BYTE_LIMIT, REPOSITORY_TERMINATION_LIMIT,
    REPOSITORY_TERMINATION_NAME_BYTE_LIMIT,
};

fn invalid(path: &str, message: impl Into<String>) -> RepositoryError {
    RepositoryError::Invalid {
        path: path.into(),
        message: message.into(),
    }
}

fn object<'a>(
    value: &'a Value,
    path: &str,
    fields: &[&str],
) -> Result<&'a Map<String, Value>, RepositoryError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(path, "must be an object"))?;
    for key in object.keys() {
        if !fields.contains(&key.as_str()) {
            return Err(invalid(&format!("{path}.{key}"), "unsupported field"));
        }
    }
    for key in fields {
        if !object.contains_key(*key) {
            return Err(invalid(&format!("{path}.{key}"), "is required"));
        }
    }
    Ok(object)
}

fn string<'a>(value: &'a Value, path: &str) -> Result<&'a str, RepositoryError> {
    value
        .as_str()
        .ok_or_else(|| invalid(path, "must be a string"))
}

fn check_string(
    text: &str,
    path: &str,
    limit: usize,
    nonempty: bool,
) -> Result<(), RepositoryError> {
    if nonempty && trim(text).is_empty() {
        return Err(invalid(path, "must be a non-empty string"));
    }
    if text.len() > limit {
        return Err(invalid(
            path,
            format!("must not exceed {limit} UTF-8 bytes"),
        ));
    }
    Ok(())
}

fn lowercase_name(text: &str) -> bool {
    let mut bytes = text.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'0'..=b'9'))
        && bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'-'))
}

fn windows_device(text: &str) -> bool {
    matches!(text, "con" | "prn" | "aux" | "nul")
        || matches!(
            text.as_bytes(),
            [b'c', b'o', b'm', b'1'..=b'9'] | [b'l', b'p', b't', b'1'..=b'9']
        )
}

fn check_id(id: &str, path: &str) -> Result<(), RepositoryError> {
    check_string(id, path, REPOSITORY_ID_BYTE_LIMIT, false)?;
    if !lowercase_name(id) || windows_device(id) {
        return Err(invalid(path, "must be a safe lowercase config id"));
    }
    Ok(())
}

fn has_scheme(url: &str) -> bool {
    url.split_once(':').is_some_and(|(scheme, _)| {
        let mut bytes = scheme.bytes();
        bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
            && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
    })
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_escape(bytes: &mut [u8], next: &mut [usize], at: usize) -> Option<u8> {
    let high = next[at];
    let low = *next.get(high)?;
    let byte = (hex(bytes[high])? << 4) | hex(*bytes.get(low)?)?;
    bytes[at] = byte;
    next[at] = next[low];
    Some(byte)
}

// Decode successive layers like decodeURIComponent. A layer visits only
// surviving percent escapes, so long chains of %25 remain linear in size.
fn decode_segment(segment: &str) -> Option<Cow<'_, str>> {
    if !segment.contains('%') {
        return Some(Cow::Borrowed(segment));
    }
    let mut bytes = segment.as_bytes().to_vec();
    let mut next: Vec<_> = (1..=bytes.len()).collect();
    let mut positions: Vec<_> = bytes
        .iter()
        .enumerate()
        .filter_map(|(index, &byte)| (byte == b'%').then_some(index))
        .collect();
    let mut following = Vec::new();
    while !positions.is_empty() {
        let mut escapes = positions.drain(..);
        while let Some(at) = escapes.next() {
            let first = decode_escape(&mut bytes, &mut next, at)?;
            let width = match first {
                b'%' => {
                    following.push(at);
                    continue;
                }
                0..=127 => continue,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => return None,
            };
            let mut utf8 = [first, 0, 0, 0];
            let mut end = at;
            for byte in &mut utf8[1..width] {
                let at = escapes.next().filter(|&index| index == next[end])?;
                *byte = decode_escape(&mut bytes, &mut next, at)?;
                end = at;
            }
            std::str::from_utf8(&utf8[..width]).ok()?;
        }
        drop(escapes);
        std::mem::swap(&mut positions, &mut following);
    }
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        decoded.push(bytes[at]);
        at = next[at];
    }
    String::from_utf8(decoded).ok().map(Cow::Owned)
}

fn check_download_url(url: &str, path: &str) -> Result<(), RepositoryError> {
    // URL parsing can strip outer spaces and ASCII controls before resolving segments.
    if url.is_empty()
        || url.trim_matches(' ') != url
        || url.bytes().any(|byte| byte.is_ascii_control())
        || url.starts_with('/')
        || url.contains(['\\', '?', '#'])
        || has_scheme(url)
    {
        return Err(invalid(path, "must be a safe relative URL path"));
    }
    for raw in url.split('/') {
        if raw.is_empty() {
            return Err(invalid(path, "must not contain empty path segments"));
        }
        let segment = decode_segment(raw)
            .ok_or_else(|| invalid(path, "contains invalid percent encoding"))?;
        if matches!(segment.as_ref(), "." | "..")
            || segment
                .bytes()
                .any(|b| b.is_ascii_control() || matches!(b, b'/' | b'\\'))
        {
            return Err(invalid(path, "must not contain unsafe path segments"));
        }
    }
    Ok(())
}

pub fn read_repository_index(index_json: &str) -> Result<ConfigRepositoryIndex, RepositoryError> {
    if index_json.len() > REPOSITORY_INDEX_TEXT_LIMIT {
        return Err(invalid("index", "must not exceed 1 MiB"));
    }
    let value =
        serde_json::from_str(index_json).map_err(|_| invalid("index", "must be valid JSON"))?;
    let index = object(&value, "index", &["format_version", "configs"])?;
    if index["format_version"].as_f64() != Some(f64::from(CONFIG_REPOSITORY_FORMAT_VERSION)) {
        return Err(invalid("index.format_version", "must be 1"));
    }
    let raw = index["configs"]
        .as_array()
        .ok_or_else(|| invalid("index.configs", "must be an array"))?;
    if raw.len() > REPOSITORY_CONFIG_LIMIT {
        return Err(invalid(
            "index.configs",
            format!("must not contain more than {REPOSITORY_CONFIG_LIMIT} entries"),
        ));
    }
    let mut configs = Vec::with_capacity(raw.len());
    let mut ids = HashSet::new();
    let mut previous = "";
    for (position, raw) in raw.iter().enumerate() {
        let path = format!("index.configs[{position}]");
        let entry = object(
            raw,
            &path,
            &["id", "name", "description", "download_url", "sha256"],
        )?;
        let id_path = format!("{path}.id");
        let id = string(&entry["id"], &id_path)?;
        check_id(id, &id_path)?;
        if !ids.insert(id) {
            return Err(invalid(&id_path, "must be unique"));
        }
        if previous > id {
            return Err(invalid(
                "index.configs",
                "must be sorted by id in ASCII order",
            ));
        }
        previous = id;
        let sha_path = format!("{path}.sha256");
        let sha256 = string(&entry["sha256"], &sha_path)?;
        if sha256.len() != 64
            || !sha256
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err(invalid(&sha_path, "must be a lowercase SHA-256 digest"));
        }
        let name_path = format!("{path}.name");
        let name = string(&entry["name"], &name_path)?;
        check_string(name, &name_path, REPOSITORY_NAME_BYTE_LIMIT, true)?;
        let desc_path = format!("{path}.description");
        let description = string(&entry["description"], &desc_path)?;
        check_string(
            description,
            &desc_path,
            REPOSITORY_DESCRIPTION_BYTE_LIMIT,
            false,
        )?;
        let url_path = format!("{path}.download_url");
        let download_url = string(&entry["download_url"], &url_path)?;
        check_download_url(download_url, &url_path)?;
        configs.push(ConfigRepositoryEntry {
            id: id.into(),
            name: name.into(),
            description: description.into(),
            download_url: download_url.into(),
            sha256: sha256.into(),
        });
    }
    Ok(ConfigRepositoryIndex {
        format_version: CONFIG_REPOSITORY_FORMAT_VERSION,
        configs,
    })
}

pub fn read_repository_manifest(manifest_yaml: &str) -> Result<ConfigManifest, RepositoryError> {
    let manifest = read_config_manifest(manifest_yaml)?;
    check_id(&manifest.id, "manifest.id")?;
    check_string(
        &manifest.name,
        "manifest.name",
        REPOSITORY_NAME_BYTE_LIMIT,
        true,
    )?;
    check_string(
        &manifest.description,
        "manifest.description",
        REPOSITORY_DESCRIPTION_BYTE_LIMIT,
        false,
    )?;
    if manifest.terminations.len() > REPOSITORY_TERMINATION_LIMIT {
        return Err(invalid(
            "manifest.terminations",
            format!("must not contain more than {REPOSITORY_TERMINATION_LIMIT} entries"),
        ));
    }
    let mut files = HashSet::new();
    for (index, term) in manifest.terminations.iter().enumerate() {
        let path = format!("manifest.terminations[{index}]");
        let file_path = format!("{path}.file");
        let safe = term
            .file
            .strip_suffix(".yaml")
            .is_some_and(|stem| lowercase_name(stem) && !windows_device(stem));
        if !safe || term.file.len() > REPOSITORY_TERMINATION_FILE_BYTE_LIMIT {
            return Err(invalid(
                &file_path,
                "must be a safe lowercase .yaml file name",
            ));
        }
        if !files.insert(&term.file) {
            return Err(invalid(&file_path, "must be unique"));
        }
        check_string(
            &term.name,
            &format!("{path}.name"),
            REPOSITORY_TERMINATION_NAME_BYTE_LIMIT,
            true,
        )?;
    }
    Ok(manifest)
}

/// Validates the repository limits, manifest identity and exact package file set.
pub fn validate_config_package(
    directory_id: &str,
    files: &[ConfigPackageBytes],
) -> Result<ConfigManifest, RepositoryError> {
    if files.len() > CONFIG_PACKAGE_FILE_LIMIT {
        return Err(invalid(
            "files",
            format!("must not contain more than {CONFIG_PACKAGE_FILE_LIMIT} entries"),
        ));
    }
    let mut exact = HashSet::new();
    let mut folded = HashSet::new();
    let mut manifest_bytes = None;
    for (index, file) in files.iter().enumerate() {
        let path = format!("files[{index}]");
        let name = file.path.as_str();
        if name.is_empty() || name.contains(['/', '\\']) {
            return Err(invalid(
                &format!("{path}.path"),
                "must be a single file name",
            ));
        }
        if !exact.insert(name) {
            return Err(invalid(&format!("{path}.path"), "must not be duplicated"));
        }
        if !folded.insert(name.to_ascii_lowercase()) {
            return Err(invalid(
                &format!("{path}.path"),
                "must not conflict after case folding",
            ));
        }
        if file.bytes.len() as u64 > CONFIG_PACKAGE_FILE_SIZE_LIMIT {
            return Err(invalid(
                &format!("{path}.size"),
                "must be a non-negative size not exceeding 1 MiB",
            ));
        }
        if name == MANIFEST_FILE {
            manifest_bytes = Some(&file.bytes);
        }
    }
    let manifest_bytes =
        manifest_bytes.ok_or_else(|| invalid("files", "missing required file: manifest.yaml"))?;
    let manifest_text = std::str::from_utf8(manifest_bytes)
        .map_err(|_| invalid(MANIFEST_FILE, "must be valid UTF-8"))?;
    let manifest = read_repository_manifest(manifest_text)?;
    if manifest.id != directory_id {
        return Err(invalid("directory_id", "must match manifest.id"));
    }
    let terminations = manifest
        .terminations
        .iter()
        .map(|term| term.file.as_str())
        .filter(|name| !matches!(*name, MANIFEST_FILE | CONFIG_FILE));
    let expected = [MANIFEST_FILE, CONFIG_FILE].into_iter().chain(terminations);
    for name in expected {
        if !exact.remove(name) {
            return Err(invalid("files", format!("missing required file: {name}")));
        }
    }
    for file in files {
        if exact.contains(file.path.as_str()) {
            return Err(invalid("files", format!("unexpected file: {}", file.path)));
        }
    }
    Ok(manifest)
}
