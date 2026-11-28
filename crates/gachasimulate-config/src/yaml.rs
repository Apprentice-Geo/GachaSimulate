use std::collections::{HashMap, HashSet};

use granit_parser::{ErrorKind, Event, Options, Parser, ScalarStyle, Tag};
use num_bigint::{BigInt, BigUint};

use crate::source::diagnostic;
use crate::{CompileDiagnostic, YamlValue, YAML_TEXT_LIMIT};

const YAML_TAG_NAMESPACE: &str = "tag:yaml.org,2002:";
const YAML_EXPANDED_TAG_LIMIT: usize = YAML_TEXT_LIMIT;
// A condition can nest both a mapping and a sequence at each condition level.
const YAML_NESTING_LIMIT: usize = 1024;

type NodeId = usize;

pub(crate) struct Document {
    nodes: Vec<Node>,
    root: NodeId,
}

struct Node {
    kind: Kind,
    tag: Option<String>,
    start: NodeId,
    key_id: Option<usize>,
}

enum Kind {
    Scalar(YamlValue),
    Sequence(Vec<NodeId>),
    Mapping(Vec<(NodeId, NodeId)>),
}

struct Collection {
    mapping: bool,
    children: Vec<NodeId>,
    tag: Option<String>,
    start: NodeId,
}

pub(crate) fn parse(text: &str, path: &str) -> Result<Document, CompileDiagnostic> {
    let error = |message: String| diagnostic(path, message);
    if text.len() > YAML_TEXT_LIMIT {
        return Err(error("must not exceed 1 MiB".into()));
    }
    let mut options = Options::default();
    options.strict_indentation = true;
    options.set_emit_comments(false);
    options.block_nesting_limit = YAML_NESTING_LIMIT;
    options.flow_nesting_limit = YAML_NESTING_LIMIT;
    options.max_directive_bytes = YAML_TEXT_LIMIT;
    options.max_reserved_directive_params = YAML_TEXT_LIMIT;

    let mut documents = 0;
    let mut remaining_tag_bytes = YAML_EXPANDED_TAG_LIMIT;
    let mut nodes = Vec::new();
    let mut stack: Vec<Collection> = Vec::new();
    let mut keys = HashMap::new();
    for event in Parser::new_from_str_with_options(text, options) {
        let (event, span) = event.map_err(|err| match err.kind() {
            ErrorKind::UnknownAnchor => error(format!("YAML aliases are not allowed ({err})")),
            _ => error(err.to_string()),
        })?;
        let (kind, tag, start) = match event {
            Event::DocumentStart(_, version) => {
                documents += 1;
                if documents > 1 {
                    return Err(error("must contain a single YAML document".into()));
                }
                if let Some(version) = version.filter(|v| (v.major, v.minor) != (1, 2)) {
                    return Err(error(format!(
                        "unsupported YAML version {}.{} (only YAML 1.2 is supported)",
                        version.major, version.minor
                    )));
                }
                continue;
            }
            Event::Alias(_) => return Err(error("YAML aliases are not allowed".into())),
            Event::Scalar(value, style, _, tag) => {
                let name = tag_name(tag.as_deref(), &mut remaining_tag_bytes, path)?;
                let scalar =
                    scalar(value.into_owned(), style, tag.as_deref()).ok_or_else(|| {
                        error(format!(
                            "invalid tagged scalar at line {} column {}",
                            span.start.line(),
                            span.start.col() + 1
                        ))
                    })?;
                (Kind::Scalar(scalar), name, nodes.len())
            }
            Event::MappingStart(_, _, ref tag) | Event::SequenceStart(_, _, ref tag) => {
                let name = tag_name(tag.as_deref(), &mut remaining_tag_bytes, path)?;
                let mapping = matches!(event, Event::MappingStart(..));
                let expected = if mapping { "map" } else { "seq" };
                if tag
                    .as_deref()
                    .and_then(Tag::core_suffix)
                    .is_some_and(|tag| tag != expected)
                {
                    return Err(error(format!("invalid tag for YAML {expected}")));
                }
                if stack.len() == YAML_NESTING_LIMIT {
                    return Err(error("YAML collection depth exceeds 1024".into()));
                }
                stack.push(Collection {
                    mapping,
                    children: Vec::new(),
                    tag: name,
                    start: nodes.len(),
                });
                continue;
            }
            Event::MappingEnd | Event::SequenceEnd => {
                let collection = stack.pop().expect("parser emitted a collection start");
                let kind = if collection.mapping {
                    let mut seen = HashSet::new();
                    let mut pairs = Vec::with_capacity(collection.children.len() / 2);
                    let (entries, remainder) = collection.children.as_chunks::<2>();
                    debug_assert!(remainder.is_empty(), "parser emitted complete pairs");
                    for &[key_node, value_node] in entries {
                        let key = key_id(key_node, &mut nodes, &mut keys);
                        if !seen.insert(key) {
                            return Err(error(
                                "map keys must be unique (duplicate YAML key)".into(),
                            ));
                        }
                        pairs.push((key_node, value_node));
                    }
                    Kind::Mapping(pairs)
                } else {
                    Kind::Sequence(collection.children)
                };
                (kind, collection.tag, collection.start)
            }
            _ => continue,
        };
        if let Some(collection) = stack.last_mut() {
            collection.children.push(nodes.len());
        }
        nodes.push(Node {
            kind,
            tag,
            start,
            key_id: None,
        });
    }
    let root = nodes
        .len()
        .checked_sub(1)
        .filter(|&id| matches!(nodes[id].kind, Kind::Mapping(_)))
        .ok_or_else(|| error("must be a mapping".into()))?;
    Ok(Document { nodes, root })
}

fn tag_name(
    tag: Option<&Tag>,
    remaining: &mut usize,
    path: &str,
) -> Result<Option<String>, CompileDiagnostic> {
    let Some(tag) = tag else {
        return Ok(None);
    };
    let (prefix, suffix) = tag.parts();
    let len = prefix.len() + suffix.len();
    *remaining = remaining
        .checked_sub(len)
        .ok_or_else(|| diagnostic(path, "expanded YAML tags exceed 1 MiB in total"))?;
    let mut name = String::with_capacity(len);
    name.push_str(prefix);
    name.push_str(suffix);
    Ok(Some(name))
}

fn scalar(text: String, style: ScalarStyle, tag: Option<&Tag>) -> Option<YamlValue> {
    if let Some(tag) = tag {
        return match tag.core_suffix() {
            Some("null") => is_null(&text).then_some(YamlValue::Null),
            Some("bool") => boolean(&text).map(YamlValue::Bool),
            Some("int") => {
                integer_parts(&text)?;
                Some(YamlValue::Integer(text))
            }
            Some("float") => float(&text, true),
            Some("map" | "seq") => None,
            _ => Some(YamlValue::String(text)),
        };
    }
    if style != ScalarStyle::Plain {
        return Some(YamlValue::String(text));
    }
    if is_null(&text) {
        Some(YamlValue::Null)
    } else if let Some(value) = boolean(&text) {
        Some(YamlValue::Bool(value))
    } else if integer_parts(&text).is_some() {
        Some(YamlValue::Integer(text))
    } else if let Some(value) = float(&text, false) {
        Some(value)
    } else {
        Some(YamlValue::String(text))
    }
}

fn is_null(text: &str) -> bool {
    matches!(text, "" | "~" | "null" | "Null" | "NULL")
}

fn boolean(text: &str) -> Option<bool> {
    match text {
        "true" | "True" | "TRUE" => Some(true),
        "false" | "False" | "FALSE" => Some(false),
        _ => None,
    }
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn integer_parts(text: &str) -> Option<(bool, u32, &str)> {
    if let Some(body) = text.strip_prefix("0x") {
        return (!body.is_empty() && body.bytes().all(|b| b.is_ascii_hexdigit()))
            .then_some((false, 16, body));
    }
    if let Some(body) = text.strip_prefix("0o") {
        return (!body.is_empty() && body.bytes().all(|b| matches!(b, b'0'..=b'7')))
            .then_some((false, 8, body));
    }
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    digits(body).then_some((text.starts_with('-'), 10, body))
}

fn float(text: &str, explicit: bool) -> Option<YamlValue> {
    let body = text.strip_prefix(['+', '-']).unwrap_or(text);
    if matches!(body, ".inf" | ".Inf" | ".INF") {
        return Some(if text.starts_with('-') {
            YamlValue::NegInfinity
        } else {
            YamlValue::Infinity
        });
    }
    if matches!(text, ".nan" | ".NaN" | ".NAN") {
        return Some(YamlValue::Nan);
    }

    let (mantissa, exponent) = body
        .split_once(['e', 'E'])
        .map_or((body, None), |(m, e)| (m, Some(e)));
    if let Some(exponent) = exponent {
        if !digits(exponent.strip_prefix(['+', '-']).unwrap_or(exponent)) {
            return None;
        }
    }
    let (whole, fractional) = mantissa
        .split_once('.')
        .map_or((mantissa, None), |(w, f)| (w, Some(f)));
    if whole.is_empty() && fractional.is_none_or(str::is_empty)
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || fractional.is_some_and(|part| !part.bytes().all(|b| b.is_ascii_digit()))
        || !(explicit || exponent.is_some() || fractional.is_some())
    {
        return None;
    }
    Some(YamlValue::Float(text.into()))
}

#[derive(Hash, PartialEq, Eq)]
enum Key {
    Null,
    Bool(bool),
    Integer(BigInt),
    Float(String, BigInt),
    Infinity,
    NegInfinity,
    Nan,
    String(String),
    Sequence(Vec<usize>),
    Mapping(Vec<(usize, usize)>),
    Tagged(String, Box<Key>),
}

fn integer_magnitude(digits: &str, radix: u32) -> BigUint {
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return BigUint::ZERO;
    }
    if radix == 10 && digits.len() > 1024 {
        // Parsing a long decimal a digit group at a time is quadratic.
        let (high, low) = digits.split_at(digits.len() / 2);
        return integer_magnitude(high, 10) * BigUint::from(10u8).pow(low.len() as u32)
            + integer_magnitude(low, 10);
    }
    BigUint::parse_bytes(digits.as_bytes(), radix).expect("validated digits")
}

fn signed_integer(negative: bool, digits: &str, radix: u32) -> BigInt {
    let value = BigInt::from(integer_magnitude(digits, radix));
    if negative {
        -value
    } else {
        value
    }
}

fn scalar_key(value: &YamlValue) -> Key {
    match value {
        YamlValue::Null => Key::Null,
        YamlValue::Bool(value) => Key::Bool(*value),
        YamlValue::Integer(text) => {
            let (negative, radix, body) = integer_parts(text).expect("resolved YAML integer");
            Key::Integer(signed_integer(negative, body, radix))
        }
        YamlValue::Float(text) => {
            let body = text.strip_prefix(['+', '-']).unwrap_or(text);
            let (mantissa, exponent) = body.split_once(['e', 'E']).unwrap_or((body, "0"));
            let (whole, fractional) = mantissa.split_once('.').unwrap_or((mantissa, ""));
            let coefficient = format!("{whole}{fractional}");
            let significant = coefficient.trim_matches('0');
            if significant.is_empty() {
                return Key::Float("0".into(), BigInt::ZERO);
            }
            let trailing = coefficient.len() - coefficient.trim_end_matches('0').len();
            let e_digits = exponent.strip_prefix(['+', '-']).unwrap_or(exponent);
            let exponent = signed_integer(exponent.starts_with('-'), e_digits, 10) + trailing
                - fractional.len();
            let sign = if text.starts_with('-') { "-" } else { "" };
            Key::Float(format!("{sign}{significant}"), exponent)
        }
        YamlValue::Infinity => Key::Infinity,
        YamlValue::NegInfinity => Key::NegInfinity,
        YamlValue::Nan => Key::Nan,
        YamlValue::String(text) => Key::String(text.clone()),
        _ => unreachable!("only scalar values are stored here"),
    }
}

// Intern keys by YAML value equality, while keeping their original spelling
// and mapping order in the document for metadata consumers.
fn key_id(root: NodeId, nodes: &mut [Node], keys: &mut HashMap<Key, usize>) -> usize {
    let mut pending = vec![(root, false)];
    while let Some((id, visited)) = pending.pop() {
        let node = &nodes[id];
        if node.key_id.is_some() {
            continue;
        }
        if !visited {
            match &node.kind {
                Kind::Sequence(nodes) => {
                    pending.push((id, true));
                    pending.extend(nodes.iter().map(|&child| (child, false)));
                    continue;
                }
                Kind::Mapping(pairs) => {
                    pending.push((id, true));
                    pending.extend(pairs.iter().flat_map(|&(k, v)| [(k, false), (v, false)]));
                    continue;
                }
                Kind::Scalar(_) => {}
            }
        }
        let child_key = |child: NodeId| nodes[child].key_id.expect("child key is interned");
        let (key, core_tag) = match &node.kind {
            Kind::Scalar(value) => {
                let key = scalar_key(value);
                let tag = match key {
                    Key::Null => "null",
                    Key::Bool(_) => "bool",
                    Key::Integer(_) => "int",
                    Key::Float(..) | Key::Infinity | Key::NegInfinity | Key::Nan => "float",
                    _ => "str",
                };
                (key, tag)
            }
            Kind::Sequence(items) => (
                Key::Sequence(items.iter().map(|&c| child_key(c)).collect()),
                "seq",
            ),
            Kind::Mapping(pairs) => {
                let mut pairs: Vec<_> = pairs
                    .iter()
                    .map(|&(k, v)| (child_key(k), child_key(v)))
                    .collect();
                pairs.sort_unstable();
                (Key::Mapping(pairs), "map")
            }
        };
        let key = match node.tag.as_deref() {
            Some(tag) if tag != "!" && tag.strip_prefix(YAML_TAG_NAMESPACE) != Some(core_tag) => {
                Key::Tagged(tag.into(), Box::new(key))
            }
            _ => key,
        };
        let next_id = keys.len();
        nodes[id].key_id = Some(*keys.entry(key).or_insert(next_id));
    }
    nodes[root].key_id.expect("root key is interned")
}

#[derive(Clone, Copy)]
pub(crate) struct Value<'a> {
    document: &'a Document,
    id: NodeId,
}

#[derive(Clone, Copy)]
pub(crate) struct Mapping<'a> {
    document: &'a Document,
    pairs: &'a [(NodeId, NodeId)],
}

impl Document {
    pub(crate) fn root(&self) -> Value<'_> {
        self.value(self.root)
    }

    fn value(&self, id: NodeId) -> Value<'_> {
        Value { document: self, id }
    }
}

impl<'a> Value<'a> {
    fn kind(self) -> Option<&'a Kind> {
        self.document.nodes.get(self.id).map(|node| &node.kind)
    }

    pub(crate) fn is_present(self) -> bool {
        self.kind().is_some()
    }

    pub(crate) fn is_null(self) -> bool {
        matches!(self.kind(), None | Some(Kind::Scalar(YamlValue::Null)))
    }

    pub(crate) fn string(self) -> Option<&'a str> {
        let node = self.document.nodes.get(self.id)?;
        let Kind::Scalar(YamlValue::String(text)) = &node.kind else {
            return None;
        };
        // These standard tags retain their scalar text for metadata. Custom
        // scalar tags fall back to strings, as in the TypeScript compiler.
        match node
            .tag
            .as_deref()
            .and_then(|tag| tag.strip_prefix(YAML_TAG_NAMESPACE))
        {
            Some("binary" | "timestamp" | "set" | "omap" | "pairs" | "merge") => None,
            _ => Some(text),
        }
    }

    pub(crate) fn integer(self) -> Option<i64> {
        match self.kind()? {
            Kind::Scalar(YamlValue::Integer(text)) => {
                let (negative, radix, body) = integer_parts(text)?;
                let amount = u64::from_str_radix(body, radix).ok()?;
                if negative {
                    i64::try_from(-i128::from(amount)).ok()
                } else {
                    i64::try_from(amount).ok()
                }
            }
            Kind::Scalar(YamlValue::Float(text)) => {
                let value: f64 = text.parse().ok()?;
                if value.is_finite()
                    && value.fract() == 0.0
                    && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&value)
                {
                    Some(value as i64)
                } else {
                    None
                }
            }
            _ => None,
        }
    }

    pub(crate) fn number(self) -> Option<f64> {
        match self.kind()? {
            Kind::Scalar(YamlValue::Integer(text)) => {
                let (_, radix, body) = integer_parts(text)?;
                if radix == 10 {
                    return text.parse().ok();
                }
                let body = body.trim_start_matches('0');
                if body.is_empty() {
                    return Some(0.0);
                }
                if body.len() > 1024usize.div_ceil(radix.ilog2() as usize) {
                    return Some(f64::INFINITY);
                }
                BigUint::parse_bytes(body.as_bytes(), radix)?
                    .to_str_radix(10)
                    .parse()
                    .ok()
            }
            Kind::Scalar(YamlValue::Float(text)) => text.parse().ok(),
            _ => None,
        }
    }

    pub(crate) fn list(self) -> Option<impl ExactSizeIterator<Item = Value<'a>>> {
        let node = self.document.nodes.get(self.id)?;
        let Kind::Sequence(ids) = &node.kind else {
            return None;
        };
        match node
            .tag
            .as_deref()
            .and_then(|tag| tag.strip_prefix(YAML_TAG_NAMESPACE))
        {
            Some("omap" | "pairs" | "set") => None,
            _ => Some(ids.iter().map(move |&id| self.document.value(id))),
        }
    }

    fn schema_key(self) -> Option<&'a str> {
        if let Some(text) = self.string() {
            return Some(text);
        }
        match self.kind()? {
            Kind::Scalar(YamlValue::Bool(true)) => Some("true"),
            Kind::Scalar(YamlValue::Bool(false)) => Some("false"),
            _ => None,
        }
    }

    pub(crate) fn metadata(self) -> Option<YamlValue> {
        let nodes = &self.document.nodes;
        let start = nodes.get(self.id)?.start;
        let mut values: Vec<Option<YamlValue>> = Vec::with_capacity(self.id - start + 1);
        for node in &nodes[start..=self.id] {
            let mut take = |id: NodeId| values[id - start].take().expect("child value");
            let value = match &node.kind {
                Kind::Scalar(scalar) => scalar.clone(),
                Kind::Sequence(items) => {
                    YamlValue::Sequence(items.iter().map(|&i| take(i)).collect())
                }
                Kind::Mapping(pairs) => {
                    YamlValue::Mapping(pairs.iter().map(|&(k, v)| (take(k), take(v))).collect())
                }
            };
            values.push(Some(match &node.tag {
                Some(tag) => YamlValue::Tagged {
                    tag: tag
                        .strip_prefix(YAML_TAG_NAMESPACE)
                        .map_or_else(|| tag.clone(), |suffix| format!("!!{suffix}")),
                    value: Box::new(value),
                },
                None => value,
            }));
        }
        values.pop().flatten()
    }
}

pub(crate) fn mapping<'a>(value: Value<'a>, path: &str) -> Result<Mapping<'a>, CompileDiagnostic> {
    let Some(Kind::Mapping(pairs)) = value.kind() else {
        return Err(diagnostic(path, "must be a mapping"));
    };
    let mut names = HashSet::new();
    for &(key, _) in pairs {
        let name = value
            .document
            .value(key)
            .schema_key()
            .ok_or_else(|| diagnostic(path, "mapping keys must be strings"))?;
        if !names.insert(name) {
            return Err(diagnostic(path, format!("duplicate schema field: {name}")));
        }
    }
    Ok(Mapping {
        document: value.document,
        pairs,
    })
}

impl<'a> Mapping<'a> {
    pub(crate) fn entries(self) -> impl ExactSizeIterator<Item = (&'a str, Value<'a>)> {
        self.pairs.iter().map(move |&(key, value)| {
            (
                self.document
                    .value(key)
                    .schema_key()
                    .expect("validated key"),
                self.document.value(value),
            )
        })
    }

    pub(crate) fn get(self, field: &str) -> Value<'a> {
        self.entries()
            .find_map(|(key, value)| (key == field).then_some(value))
            .unwrap_or_else(|| self.document.value(usize::MAX))
    }
}
