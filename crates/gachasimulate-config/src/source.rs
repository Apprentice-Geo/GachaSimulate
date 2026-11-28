use std::collections::HashSet;

use crate::yaml::{self, mapping, Mapping, Value};
use crate::{CompileDiagnostic, CompileError, ConfigItem, ConfigManifest, ConfigTermination};

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

pub(crate) fn diagnostic(path: &str, message: impl Into<String>) -> CompileDiagnostic {
    CompileDiagnostic {
        path: path.into(),
        message: message.into(),
    }
}

pub(crate) fn is_identifier(id: &str) -> bool {
    let mut bytes = id.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

// Repository and manifest validation use the same trimmed-string test as JS.
pub(crate) fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub(crate) fn is_js_whitespace(ch: char) -> bool {
    (ch.is_whitespace() && ch != '\u{85}') || ch == '\u{feff}'
}

pub(crate) fn list<'a>(
    value: Value<'a>,
    path: &str,
) -> Result<impl ExactSizeIterator<Item = Value<'a>>, CompileDiagnostic> {
    value
        .list()
        .ok_or_else(|| diagnostic(path, "must be a list"))
}

pub(crate) fn only_fields(
    value: Mapping<'_>,
    path: &str,
    fields: &[&str],
) -> Result<(), CompileDiagnostic> {
    for (name, _) in value.entries() {
        if !fields.contains(&name) {
            return Err(diagnostic(&format!("{path}.{name}"), "unsupported field"));
        }
    }
    Ok(())
}

pub(crate) fn single_field<'a>(
    value: Value<'a>,
    path: &str,
) -> Result<(&'a str, Value<'a>), CompileDiagnostic> {
    let mut fields = mapping(value, path)?.entries();
    if fields.len() == 1 {
        Ok(fields.next().expect("one mapping entry"))
    } else {
        Err(diagnostic(path, "must be a single-key mapping"))
    }
}

pub(crate) fn safe_integer(
    value: Option<i64>,
    path: &str,
    positive: bool,
) -> Result<i64, CompileDiagnostic> {
    value
        .filter(|value| (i64::from(positive)..=MAX_SAFE_INTEGER).contains(value))
        .ok_or_else(|| {
            let sign = if positive { "positive" } else { "non-negative" };
            diagnostic(path, format!("must be a {sign} safe integer"))
        })
}

pub(crate) fn config_items(value: Value<'_>) -> Result<Vec<ConfigItem>, CompileDiagnostic> {
    let items = list(value, "config.items")?;
    if items.len() == 0 {
        return Err(diagnostic("config.items", "must be non-empty"));
    }
    let mut ids = HashSet::new();
    items
        .enumerate()
        .map(|(index, value)| {
            let path = format!("config.items[{index}]");
            let (id, name) = if let Some(id) = value.string() {
                (id, Some(id))
            } else {
                let (id, name) = single_field(value, &path)?;
                (id, name.string())
            };
            if !is_identifier(id) {
                return Err(diagnostic(&path, "invalid item id"));
            }
            if !ids.insert(id) {
                return Err(diagnostic(&path, format!("duplicate item id: {id}")));
            }
            let name = name
                .filter(|name| !name.is_empty())
                .ok_or_else(|| diagnostic(&path, "name must be a non-empty string"))?;
            Ok(ConfigItem {
                id: id.into(),
                name: name.into(),
            })
        })
        .collect()
}

pub fn read_config_items(config_yaml: &str) -> Result<Vec<ConfigItem>, CompileError> {
    let config = yaml::parse(config_yaml, "config")?;
    Ok(config_items(
        mapping(config.root(), "config")?.get("items"),
    )?)
}

pub(crate) fn config_manifest(value: Value<'_>) -> Result<ConfigManifest, CompileDiagnostic> {
    let manifest = mapping(value, "manifest")?;
    only_fields(
        manifest,
        "manifest",
        &["id", "name", "description", "terminations", "metadata"],
    )?;
    let id = manifest
        .get("id")
        .string()
        .filter(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
        })
        .ok_or_else(|| diagnostic("manifest.id", "must be a valid config id"))?;
    let name = manifest
        .get("name")
        .string()
        .filter(|name| !trim(name).is_empty())
        .ok_or_else(|| diagnostic("manifest.name", "must be a non-empty string"))?;
    let description = manifest
        .get("description")
        .string()
        .ok_or_else(|| diagnostic("manifest.description", "must be a string"))?;
    let raw = list(manifest.get("terminations"), "manifest.terminations")?;
    if raw.len() == 0 {
        return Err(diagnostic("manifest.terminations", "must be non-empty"));
    }
    let terminations = raw
        .enumerate()
        .map(|(index, value)| {
            let path = format!("manifest.terminations[{index}]");
            let term = mapping(value, &path)?;
            only_fields(term, &path, &["file", "name"])?;
            let file = term
                .get("file")
                .string()
                .filter(|file| !file.is_empty() && !file.contains(['/', '\\']))
                .ok_or_else(|| {
                    diagnostic(&format!("{path}.file"), "must be a non-empty file name")
                })?;
            let name = term
                .get("name")
                .string()
                .filter(|name| !trim(name).is_empty())
                .ok_or_else(|| diagnostic(&format!("{path}.name"), "must be a non-empty string"))?;
            Ok(ConfigTermination {
                file: file.into(),
                name: name.into(),
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(ConfigManifest {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        terminations,
        metadata: manifest.get("metadata").metadata(),
    })
}

pub fn read_config_manifest(manifest_yaml: &str) -> Result<ConfigManifest, CompileError> {
    let manifest = yaml::parse(manifest_yaml, "manifest")?;
    Ok(config_manifest(manifest.root())?)
}
