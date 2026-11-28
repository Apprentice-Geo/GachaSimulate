use gachasimulate_config::{
    compile_snapshot, compile_yaml, read_config_items, read_config_manifest, validate_config_files,
    Action, CompileDiagnostic, CompileError, CompiledProgram, ConditionNode, ConfigSnapshot,
    RuleMode, TerminationSource, YamlValue, MAX_CONDITION_DEPTH, YAML_TEXT_LIMIT,
};
use serde_json::{json, Value};

const CONFIG: &str = "schema_version: 2
items: [draw_count, target, token]
pools:
- main:
  - probability: 1
    actions: target += 1
every_draw: draw_count += 1
";
const TERMINATION: &str = "retained_items: []
termination_rule:
  condition:
    check: target >= 1
    actions: terminate done
";
const MANIFEST: &str = "id: test
name: Test
description: Test config
terminations:
- file: termination.yaml
  name: Done
";

fn compile(config: &str, termination: &str) -> Result<CompiledProgram, CompileError> {
    compile_yaml(config, termination, MANIFEST, "draw_count")
}

fn rejected<T: std::fmt::Debug>(
    result: Result<T, CompileError>,
    path: &str,
    message: &str,
) -> CompileDiagnostic {
    let CompileError::Diagnostic(error) = result.unwrap_err() else {
        panic!("expected compiler diagnostic");
    };
    assert_eq!(error.path, path, "{error}");
    assert!(error.message.contains(message), "{error}");
    error
}

#[test]
fn parses_strict_single_documents_and_utf8_limits() {
    for (source, message) in [
        ("items: [a]\nitems: [b]\n", "unique"),
        ("items: &list [a]\ncopy: *list\n", "alias"),
        ("items: *undefined\n", "alias"),
        ("items: [a]\n---\nitems: [b]\n", "single YAML document"),
        ("items: [a\n", ""),
        ("[a, b]\n", "must be a mapping"),
        ("", "must be a mapping"),
        ("items: [{id: \"\\uD800\"}]\n", ""),
        ("items: [{id: \"\\uDC00\"}]\n", ""),
        ("items: [a]\n\0ignored\n", ""),
    ] {
        rejected(read_config_items(source), "config", message);
    }
    let items =
        read_config_items("---\nitems: &list [draw_count, {target: 目标}, {emoji: 😀}]\n...\n")
            .unwrap();
    assert_eq!(items[0].id, items[0].name);
    assert_eq!(items[1].name, "目标");
    assert_eq!(items[2].name, "😀");

    let padded = |source: &str| {
        format!(
            "{source}#{}",
            "x".repeat(YAML_TEXT_LIMIT - source.len() - 1)
        )
    };
    let config = padded(CONFIG);
    let termination = padded(TERMINATION);
    let manifest = padded(MANIFEST);
    compile_yaml(&config, &termination, &manifest, "draw_count").unwrap();
    validate_config_files(&config, &[term("max.yaml", &termination)]).unwrap();
    rejected(read_config_items(&format!("{config}界")), "config", "1 MiB");
    rejected(
        compile(CONFIG, &format!("{termination}界")),
        "termination",
        "1 MiB",
    );
    rejected(
        read_config_manifest(&format!("{manifest}界")),
        "manifest",
        "1 MiB",
    );
    let oversized = validate_config_files(CONFIG, &[term("max.yaml", &format!("{termination}界"))])
        .unwrap_err();
    assert_eq!(oversized.failed_files, ["max.yaml"]);
    assert_eq!(oversized.diagnostics[0].path, "termination");
    assert_eq!(
        validate_config_files(&format!("{config}界"), &[])
            .unwrap_err()
            .failed_files,
        ["config.yaml"],
    );
}

#[test]
fn bounds_total_expanded_tag_bytes_for_scalars_and_collections() {
    let namespace = "tag:example.com,2026:";
    let prefix = format!(
        "{namespace}{}",
        "x".repeat(YAML_TEXT_LIMIT / 8 - namespace.len() - 1)
    );
    let mut source = format!("%TAG !long! {prefix}\n---\n{MANIFEST}metadata:\n");
    let tagged_nodes = [
        "- !long!x scalar\n",
        "- !long!x [1]\n",
        "- !long!x {a: 1}\n",
    ];
    for tagged in tagged_nodes.iter().cycle().take(8) {
        source.push_str(tagged);
    }
    // Eight expansions consume exactly the budget, though the source is much smaller.
    assert!(source.len() < YAML_TEXT_LIMIT / 4);
    read_config_manifest(&source).unwrap();
    for tagged in tagged_nodes {
        rejected(
            read_config_manifest(&format!("{source}{tagged}")),
            "manifest",
            "expanded YAML tags exceed 1 MiB",
        );
    }
}

#[test]
fn accepts_yaml_1_2_and_rejects_other_version_directives() {
    compile(&format!("%YAML 1.2\n---\n{CONFIG}"), TERMINATION).unwrap();
    for version in ["1.1", "1.3"] {
        rejected(
            compile(&format!("%YAML {version}\n---\n{CONFIG}"), TERMINATION),
            "config",
            &format!("unsupported YAML version {version}"),
        );
    }
}

#[test]
fn validates_effective_schema_keys_and_preserves_metadata_key_tags() {
    let manifest = MANIFEST.replace("name: Test", "!custom name: First\nname: Second");
    rejected(
        read_config_manifest(&manifest),
        "manifest",
        "duplicate schema field: name",
    );
    let config = CONFIG.replace("items:", "!custom items: [other]\nitems:");
    rejected(
        compile(&config, TERMINATION),
        "config",
        "duplicate schema field: items",
    );
    rejected(
        read_config_items("items: [target]\n!custom unused: First\nunused: Second\n"),
        "config",
        "duplicate schema field: unused",
    );
    rejected(
        read_config_items("items: [{!!binary SGVsbG8: Hello}]"),
        "config.items[0]",
        "keys must be strings",
    );
    rejected(
        read_config_items("items: [{1: One}]"),
        "config.items[0]",
        "keys must be strings",
    );
    let bool_key_items = read_config_items("items: [{true: Lucky}]").unwrap();
    assert_eq!(bool_key_items[0].id, "true");
    assert_eq!(bool_key_items[0].name, "Lucky");
    let metadata = format!("{MANIFEST}metadata: {{!custom name: First, name: Second}}");
    assert_eq!(
        read_config_manifest(&metadata).unwrap().metadata,
        Some(YamlValue::Mapping(vec![
            (
                YamlValue::Tagged {
                    tag: "!custom".into(),
                    value: Box::new(YamlValue::String("name".into())),
                },
                YamlValue::String("First".into()),
            ),
            (
                YamlValue::String("name".into()),
                YamlValue::String("Second".into())
            ),
        ]))
    );
}

#[test]
fn rejects_non_string_yaml_tags_in_schema_strings_and_preserves_metadata() {
    for (tag, text) in [
        ("!!binary", "SGVsbG8="),
        ("!!timestamp", "2026-01-01"),
        ("!!set", "set"),
        ("!!omap", "ordered map"),
        ("!!pairs", "pairs"),
        ("!!merge", "<<"),
    ] {
        let scalar = format!("{tag} {text}");
        rejected(
            read_config_manifest(&MANIFEST.replace("name: Test", &format!("name: {scalar}"))),
            "manifest.name",
            "must be a non-empty string",
        );
        rejected(
            read_config_items(&format!("items: [{{target: {scalar}}}]")),
            "config.items[0]",
            "name must be a non-empty string",
        );
        assert_eq!(
            read_config_manifest(&format!("{MANIFEST}metadata: {scalar}"))
                .unwrap()
                .metadata,
            Some(YamlValue::Tagged {
                tag: tag.into(),
                value: Box::new(YamlValue::String(text.into())),
            })
        );
    }
    rejected(
        read_config_items(
            "%TAG !std! tag:yaml.org,2002:time\n---\nitems: [{target: !std!stamp 2026-01-01}]",
        ),
        "config.items[0]",
        "name must be a non-empty string",
    );
    let items = read_config_items("items: [{a: !!str 12}, {b: !custom 34}]").unwrap();
    assert_eq!(items[0].name, "12");
    assert_eq!(items[1].name, "34");
}

#[test]
fn validates_schema_items_manifest_and_result_item() {
    for bad in ["1", "true", "2.5", "\"2\"", "null", "[]"] {
        let config = CONFIG.replace("schema_version: 2", &format!("schema_version: {bad}"));
        rejected(
            compile(&config, TERMINATION),
            "config.schema_version",
            "must be 2",
        );
    }
    for good in ["0x2", "0o2", "+02", "2.0", "2e0", "!!int '2'"] {
        let config = CONFIG.replace("schema_version: 2", &format!("schema_version: {good}"));
        compile(&config, TERMINATION).unwrap();
    }
    for (items, path, message) in [
        ("[]", "config.items", "non-empty"),
        ("[bad-id]", "config.items[0]", "invalid item id"),
        ("[same, same]", "config.items[1]", "duplicate item id: same"),
        (
            "[{valid: ''}]",
            "config.items[0]",
            "name must be a non-empty string",
        ),
        (
            "[{valid: false}]",
            "config.items[0]",
            "name must be a non-empty string",
        ),
        ("[{a: A, b: B}]", "config.items[0]", "single-key"),
        ("[false]", "config.items[0]", "must be a mapping"),
    ] {
        rejected(read_config_items(&format!("items: {items}")), path, message);
    }
    let program = compile_yaml(CONFIG, TERMINATION, MANIFEST, "target").unwrap();
    assert_eq!(program.result_item, 1);
    assert_eq!(program.items[1].name, "target");
    rejected(
        compile_yaml(CONFIG, TERMINATION, MANIFEST, "missing"),
        "result_item",
        "unknown item id",
    );
    rejected(
        compile_yaml(CONFIG, TERMINATION, MANIFEST, "1target"),
        "result_item",
        "must be an item id",
    );
    for (source, path) in [
        ("", "manifest"),
        ("id: invalid\n", "manifest.name"),
        ("metrics: [draw]\n", "manifest.metrics"),
        ("result_item: target\n", "manifest.result_item"),
        (&MANIFEST.replace("id: test\n", ""), "manifest.id"),
        (&MANIFEST.replace("id: test", "id: bad.id"), "manifest.id"),
        (
            &MANIFEST.replace("name: Test", "name: '  '"),
            "manifest.name",
        ),
        (
            &MANIFEST.replace("description: Test config", "description: true"),
            "manifest.description",
        ),
        (
            &MANIFEST.replace("description: Test config\n", ""),
            "manifest.description",
        ),
        (
            "id: test\nname: Test\ndescription: ''\nterminations: []",
            "manifest.terminations",
        ),
        (
            &MANIFEST.replace("termination.yaml", "nested/done.yaml"),
            "manifest.terminations[0].file",
        ),
        (
            &MANIFEST.replace("termination.yaml", "nested\\done.yaml"),
            "manifest.terminations[0].file",
        ),
        (
            &MANIFEST.replace("termination.yaml", "''"),
            "manifest.terminations[0].file",
        ),
        (
            &MANIFEST.replace("name: Done", "name: ''"),
            "manifest.terminations[0].name",
        ),
        (
            &format!("{MANIFEST}  extra: true\n"),
            "manifest.terminations[0].extra",
        ),
    ] {
        rejected(
            compile_yaml(CONFIG, TERMINATION, source, "draw_count"),
            path,
            "",
        );
    }
}

#[test]
fn preserves_typed_manifest_metadata_and_rejects_semantic_duplicate_keys() {
    let source = format!(
        "{MANIFEST}metadata:
  42: [true, 'true', null, .inf, -.Inf, .NaN, 01, 0xFf, 1.0e+400]
  ? [left, {{right: 1234567890123456789012345678901234567890}}]
  : !!binary SGVsbG8=
  label: !game {{data: !!set {{a: null, b: null}}}}
  typed: !!str 2
"
    );
    let big = "1234567890123456789012345678901234567890";
    use YamlValue::*;
    fn s(text: &str) -> YamlValue {
        String(text.into())
    }
    fn tagged(tag: &str, value: YamlValue) -> YamlValue {
        Tagged {
            tag: tag.into(),
            value: Box::new(value),
        }
    }
    assert_eq!(
        read_config_manifest(&source).unwrap().metadata,
        Some(Mapping(vec![
            (
                Integer("42".into()),
                Sequence(vec![
                    Bool(true),
                    s("true"),
                    Null,
                    Infinity,
                    NegInfinity,
                    Nan,
                    Integer("01".into()),
                    Integer("0xFf".into()),
                    Float("1.0e+400".into()),
                ])
            ),
            (
                Sequence(vec![
                    s("left"),
                    Mapping(vec![(s("right"), Integer(big.into()))])
                ]),
                tagged("!!binary", s("SGVsbG8="))
            ),
            (
                s("label"),
                tagged(
                    "!game",
                    Mapping(vec![(
                        s("data"),
                        tagged("!!set", Mapping(vec![(s("a"), Null), (s("b"), Null)]))
                    )])
                )
            ),
            (s("typed"), tagged("!!str", s("2"))),
        ])),
    );
    assert_eq!(read_config_manifest(MANIFEST).unwrap().metadata, None);
    assert_eq!(
        read_config_manifest(&format!("{MANIFEST}metadata: null"))
            .unwrap()
            .metadata,
        Some(Null)
    );
    for keys in [
        "{1: a, 0x01: b}",
        "{True: a, true: b}",
        "{null: a, ~: b}",
        "{a: first, !!str a: second}",
        "{.NaN: a, .nan: b}",
        "{1.0e+400: a, 0.10e401: b}",
        "{[a, 1]: first, [a, 0o1]: second}",
        "{{a: 1, b: 2}: first, {b: 2, a: 1}: second}",
    ] {
        rejected(
            read_config_manifest(&format!("{MANIFEST}metadata: {keys}")),
            "manifest",
            "unique",
        );
    }
    let distinct =
        "{1: int, 1.0: float, '1': str, true: bool, 'true': str, 1.00000000000000001: precise}";
    read_config_manifest(&format!("{MANIFEST}metadata: {distinct}")).unwrap();
    let large_key = format!("1{}1", "0".repeat(2048));
    let duplicates =
        format!("{MANIFEST}metadata:\n  ? {large_key}\n  : first\n  ? +0{large_key}\n  : second\n");
    rejected(read_config_manifest(&duplicates), "manifest", "unique");
}

fn pool(entries: &str) -> String {
    format!("schema_version: 2\nitems: [draw_count, target]\npools:\n- main:\n{entries}")
}

#[test]
fn normalizes_pool_thresholds_and_rejects_invalid_weights_and_shapes() {
    let path = "config.pools[0].main";
    for (entries, expected) in [
        ("  - weight: 8e307\n  - weight: 8e307\n", vec![0.5, 1.0]),
        ("  - weight: 0x2\n  - weight: 0o6\n", vec![0.25, 1.0]),
        (
            "  - probability: .3\n  - probability: 0.6999999999\n",
            vec![0.3, 1.0],
        ),
    ] {
        let program = compile(&pool(entries), TERMINATION).unwrap();
        assert_eq!(
            program
                .pool_entries
                .iter()
                .map(|e| e.threshold)
                .collect::<Vec<_>>(),
            expected
        );
    }
    for (entries, error_path, message) in [
        (
            "  - probability: .3\n  - probability: .6\n",
            path,
            "probability sum must be 1",
        ),
        (
            "  - weight: 1e308\n  - weight: 1e308\n",
            path,
            "weight sum must be finite",
        ),
        (
            "  - weight: 1\n  - weight: 1e-300\n",
            path,
            "thresholds must strictly increase",
        ),
        (
            "  - weight: 1e-300\n  - weight: 1e300\n",
            path,
            "thresholds must strictly increase",
        ),
        (
            "  - probability: 1\n  - probability: 1e-12\n",
            path,
            "thresholds must strictly increase",
        ),
        (
            "  - weight: 1\n  - probability: 1\n",
            "config.pools[0].main[1]",
            "cannot mix",
        ),
        (
            "  - weight: 1\n    probability: 1\n",
            "config.pools[0].main[0]",
            "exactly one",
        ),
        (
            "  - actions: null\n",
            "config.pools[0].main[0]",
            "exactly one",
        ),
        (
            "  - weight: 1\n    extra: 4\n",
            "config.pools[0].main[0].extra",
            "unsupported field",
        ),
    ] {
        let config = pool(entries);
        rejected(compile(&config, TERMINATION), error_path, message);
        assert_eq!(
            validate_config_files(&config, &[])
                .unwrap_err()
                .failed_files,
            ["config.yaml"]
        );
    }
    for number in ["0", "-1", "false", "'1'", ".inf", ".nan", "1.0e400"] {
        rejected(
            compile(&pool(&format!("  - weight: {number}\n")), TERMINATION),
            "config.pools[0].main[0].weight",
            "finite positive number",
        );
    }
    for (pools, path) in [
        ("[]", "config.pools"),
        ("[{main: []}]", "config.pools[0].main"),
        (
            "[{main: [{weight: 1}]}, {main: [{weight: 1}]}]",
            "config.pools[1]",
        ),
        ("[{bad-id: [{weight: 1}]}]", "config.pools[0]"),
    ] {
        let config = format!("schema_version: 2\nitems: [draw_count, target]\npools: {pools}");
        rejected(compile(&config, TERMINATION), path, "");
    }
}

#[test]
fn retains_maximum_for_resolved_items_and_checks_integer_boundaries() {
    let config = format!(
        "{CONFIG}item_resolve:
- item: target
  retain: 4294967296
  actions: target -= 9007199254740991
"
    );
    let retained = TERMINATION.replace("[]", "[{target: 9007199254740991}, {token: 3}]");
    let program = compile(&config, &retained).unwrap();
    let resolve = program.item_resolves[1].unwrap();
    assert_eq!(resolve.retain, 9_007_199_254_740_991);
    assert_eq!(resolve.reduce_per_batch, 9_007_199_254_740_991);
    assert!(program.item_resolves[2].is_none());
    assert_eq!(
        compile(&config, TERMINATION).unwrap().item_resolves[1]
            .unwrap()
            .retain,
        4_294_967_296
    );
    for count in ["true", "1.5", "-1", "'1'", "9007199254740992"] {
        rejected(
            compile(&config.replace("4294967296", count), TERMINATION),
            "config.item_resolve[0].retain",
            "safe integer",
        );
        rejected(
            compile(
                &config,
                &TERMINATION.replace("[]", &format!("[{{token: {count}}}]")),
            ),
            "termination.retained_items[0].token",
            "safe integer",
        );
    }
    for raw in [
        "null",
        "[]",
        "[target += 1]",
        "[target -= 1, token -= 1]",
        "[target -= 1, target -= 1]",
    ] {
        let bad = config.replace("target -= 9007199254740991", raw);
        rejected(
            compile(&bad, TERMINATION),
            "config.item_resolve[0].actions",
            "exactly one reduce action",
        );
    }
    let duplicate = format!("{config}- {{item: target, retain: 0, actions: target -= 1}}\n");
    rejected(
        compile(&duplicate, TERMINATION),
        "config.item_resolve[1].item",
        "unknown or duplicate resolved item",
    );
    for (retained, path) in [
        ("[{missing: 1}]", "termination.retained_items[0]"),
        ("[{token: 1}, {token: 2}]", "termination.retained_items[1]"),
    ] {
        rejected(
            compile(CONFIG, &TERMINATION.replace("[]", retained)),
            path,
            "unknown or duplicate retained item",
        );
    }
    rejected(
        compile(CONFIG, &format!("{TERMINATION}schema_version: 2")),
        "termination.schema_version",
        "unsupported field",
    );
    rejected(
        compile(CONFIG, &TERMINATION.replace("retained_items: []\n", "")),
        "termination.retained_items",
        "must be a list",
    );
}

fn action_sources(action: &str) -> Vec<(String, String, &'static str)> {
    let base = json!({
        "schema_version": 2,
        "items": ["draw_count", "target", "token"],
        "pools": [{"main": [{"probability": 1}]}, {"auxiliary": [{"probability": 1}]}]
    });
    let mut cases = Vec::new();
    for (pointer, value, path) in [
        ("/initial", json!(action), "config.initial[0]"),
        ("/every_draw", json!([action]), "config.every_draw[0]"),
        (
            "/pools/0/main/0/actions",
            json!(action),
            "config.pools[0].main[0].actions[0]",
        ),
        (
            "/item_resolve",
            json!([{"item":"token", "retain":0, "actions":["token -= 1", action]}]),
            "config.item_resolve[0].actions[1]",
        ),
        (
            "/rules",
            json!([{"r":{"condition":{"check":"draw_count >= 1","actions":action}}}]),
            "config.rules[0].r.condition.actions[0]",
        ),
        (
            "/rules",
            json!([{"r":{"mode":"repeat","condition":{"check":"draw_count >= 1","actions":[action, "draw_count -= 1"]}}}]),
            "config.rules[0].r.condition.actions[0]",
        ),
    ] {
        let mut configured = base.clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        configured.pointer_mut(parent).unwrap()[key] = value;
        cases.push((configured.to_string(), TERMINATION.into(), path));
    }
    let termination = json!({"retained_items":[], "termination_rule": {
        "condition": {"check":"target >= 1", "actions":[action, "terminate done"]}
    }});
    cases.push((
        base.to_string(),
        termination.to_string(),
        "termination.termination_rule.condition.actions[0]",
    ));
    cases
}

#[test]
fn shares_command_whitespace_parsing_and_checks_action_and_condition_references() {
    for (command, target) in [
        ("draw", "auxiliary"),
        ("change", "auxiliary"),
        ("terminate", "done"),
    ] {
        for separator in [" ", "  ", "\t", "\n"] {
            for (config, termination, path) in
                action_sources(&format!("{command}{separator}{target}"))
            {
                if separator.starts_with(' ') {
                    compile(&config, &termination).unwrap();
                } else {
                    rejected(compile(&config, &termination), path, "unsupported action");
                }
            }
        }
    }
    for (action, path, message) in [
        ("target += 0", "config.initial[0]", "positive safe integer"),
        ("target -= 0", "config.initial[0]", "positive safe integer"),
        (
            "target = 9007199254740992",
            "config.initial[0]",
            "non-negative safe integer",
        ),
        ("target = -1", "config.initial[0]", "unsupported action"),
        ("target = 1.0", "config.initial[0]", "unsupported action"),
        (
            "missing += 1",
            "config.initial[0]",
            "unknown item id: missing",
        ),
        (
            "draw missing",
            "config.initial[0]",
            "unknown pool id: missing",
        ),
        (
            "change missing",
            "config.initial[0]",
            "unknown pool id: missing",
        ),
        ("terminate   ", "config.initial[0]", "unsupported action"),
    ] {
        rejected(
            compile(&format!("{CONFIG}initial: {}", json!(action)), TERMINATION),
            path,
            message,
        );
    }
    let valid = compile(
        &format!(
            "{CONFIG}initial: {}",
            json!(["target\t=\t000", "draw_count += 1"])
        ),
        TERMINATION,
    )
    .unwrap();
    assert_eq!(
        valid.initial.get(&valid.actions).unwrap(),
        [
            Action::SetItem { item: 1, amount: 0 },
            Action::AddItem { item: 0, amount: 1 },
        ]
    );
    for (check, message) in [
        ("missing >= 1", "unknown item id"),
        ("target >= -1", "unsupported condition"),
        ("target > 1.0", "unsupported condition"),
        ("target == draw_count", "unsupported condition"),
        ("target >= 9007199254740992", "safe integer"),
    ] {
        rejected(
            compile(CONFIG, &TERMINATION.replace("target >= 1", check)),
            "termination.termination_rule.condition.check",
            message,
        );
    }
    rejected(
        compile(
            &format!("{CONFIG}initial: [target = 0, false]"),
            TERMINATION,
        ),
        "config.initial[1]",
        "must be an action string",
    );
}

fn termination_with(condition: Value) -> String {
    json!({"retained_items": [], "termination_rule": {"condition": condition}}).to_string()
}

#[test]
fn keeps_children_contiguous_and_checks_every_termination_path() {
    let stop = json!({"check":"target >= 1", "actions":"terminate done"});
    let empty = json!({"check":"draw_count >= 1"});
    for op in ["AND", "&&", "OR", "||"] {
        let parent = json!({"op":op, "children":[empty, stop]});
        let result = compile(CONFIG, &termination_with(parent.clone()));
        if matches!(op, "AND" | "&&") {
            result.unwrap();
        } else {
            rejected(
                result,
                "termination.termination_rule.condition",
                "every termination path",
            );
        }
        let root = json!({"op":"OR","actions":"terminate parent","children":[parent, stop]});
        let p = compile(CONFIG, &termination_with(root)).unwrap();
        let ConditionNode::Logic {
            children, actions, ..
        } = p.condition_nodes[p.termination_condition as usize]
        else {
            panic!("root is a logic node");
        };
        assert_eq!(
            actions.get(&p.actions).unwrap(),
            [Action::Terminate { reason: 1 }]
        );
        let direct = children.get(&p.condition_children).unwrap();
        let ConditionNode::Logic { children, .. } = p.condition_nodes[direct[0] as usize] else {
            panic!("first child is a logic node");
        };
        assert!(matches!(
            p.condition_nodes[direct[1] as usize],
            ConditionNode::Check { .. }
        ));
        for &child in children.get(&p.condition_children).unwrap() {
            assert!(matches!(
                p.condition_nodes[child as usize],
                ConditionNode::Check { .. }
            ));
        }
    }
    for (node, path, message) in [
        (
            json!({"check":"target > 0", "op":"AND", "children":[stop]}),
            ".children",
            "unsupported field",
        ),
        (
            json!({"op":"OR", "children":[]}),
            ".children",
            "must be non-empty",
        ),
        (
            json!({"op":"XOR", "children":[stop]}),
            ".op",
            "unsupported logic op",
        ),
        (
            json!({"check":true}),
            ".check",
            "must be a condition string",
        ),
        (
            json!({"check":"target > 0", "actions":"draw main"}),
            "",
            "every termination path",
        ),
    ] {
        rejected(
            compile(CONFIG, &termination_with(node)),
            &format!("termination.termination_rule.condition{path}"),
            message,
        );
    }
}

fn deep_termination(depth: usize, flow: bool) -> String {
    let mut source = "retained_items: []\ntermination_rule:\n  condition:".to_string();
    if flow {
        source.push(' ');
        source.push_str(&"{op: AND, children: [".repeat(depth - 1));
        source.push_str("{check: target >= 1, actions: terminate done}");
        source.push_str(&"]}".repeat(depth - 1));
    } else {
        source.push('\n');
        for level in 0..depth - 1 {
            let pad = " ".repeat(4 + level * 2);
            source.push_str(&format!("{pad}op: AND\n{pad}children:\n{pad}-\n"));
        }
        let pad = " ".repeat(4 + (depth - 1) * 2);
        source.push_str(&format!(
            "{pad}check: target >= 1\n{pad}actions: terminate done\n"
        ));
    }
    source
}

#[test]
fn bounds_condition_depth_in_block_and_flow_yaml() {
    for flow in [false, true] {
        let term = deep_termination(MAX_CONDITION_DEPTH, flow);
        let program = compile(CONFIG, &term).unwrap();
        assert_eq!(program.condition_nodes.len(), MAX_CONDITION_DEPTH);
        let term = deep_termination(MAX_CONDITION_DEPTH + 1, flow);
        let error = compile(CONFIG, &term).unwrap_err().to_string();
        assert!(error.contains("condition depth exceeds 256"), "{error}");
    }
}

fn repeat(condition: &str) -> String {
    format!("rules:\n- r: {{mode: repeat, condition: {condition}}}\n")
}

#[test]
fn proves_repeat_exits_and_rule_modes() {
    for (check, action) in [
        (">= 1", "-= 1"),
        ("> 1", "-= 1"),
        ("<= 1", "+= 1"),
        ("< 1", "+= 1"),
        ("== 1", "+= 1"),
        ("== 1", "-= 1"),
        ("!= 1", "= 1"),
        (">= 1", "= 0"),
    ] {
        let condition = format!("{{check: target {check}, actions: target {action}}}");
        compile(&format!("{CONFIG}{}", repeat(&condition)), TERMINATION).unwrap();
    }
    for (condition, message, suffix) in [
        (
            "{check: target >= 1, actions: draw_count += 1}",
            "write checked item exactly once",
            ".actions",
        ),
        (
            "{check: target >= 1, actions: target += 1}",
            "does not make the condition false",
            ".actions",
        ),
        (
            "{check: target != 1, actions: target += 1}",
            "does not make the condition false",
            ".actions",
        ),
        (
            "{check: target >= 1, actions: [target -= 1, target -= 1]}",
            "write checked item exactly once",
            ".actions",
        ),
        (
            "{op: AND, children: [{check: target >= 1, actions: target -= 1}]}",
            "single check",
            "",
        ),
    ] {
        rejected(
            compile(&format!("{CONFIG}{}", repeat(condition)), TERMINATION),
            &format!("config.rules[0].r.condition{suffix}"),
            message,
        );
    }
    let modes = "rules:
- a: {condition: {check: target >= 1, actions: target += 1}}
- b: {mode: per_draw, condition: {check: target >= 1, actions: target += 1}}
- c: {mode: repeat, condition: {check: target >= 1, actions: terminate done}}
";
    let program = compile(&format!("{CONFIG}{modes}"), TERMINATION).unwrap();
    assert_eq!(
        program.rules.iter().map(|r| r.mode).collect::<Vec<_>>(),
        [RuleMode::Once, RuleMode::PerDraw, RuleMode::Repeat]
    );
    for (rule, path, message) in [
        ("- bad-id: {}", "config.rules[0]", "invalid rule id"),
        (
            "- a: {condition: {check: target >= 1}}",
            "config.rules[0].a.condition",
            "at least one action",
        ),
        (
            "- a: {mode: always}",
            "config.rules[0].a.mode",
            "unsupported mode",
        ),
        (
            "- a: {unknown: true}",
            "config.rules[0].a.unknown",
            "unsupported field",
        ),
        (
            "- a: {condition: {check: target >= 1, actions: target += 1}}\n- a: {}",
            "config.rules[1]",
            "duplicate rule id",
        ),
    ] {
        rejected(
            compile(&format!("{CONFIG}rules:\n{rule}"), TERMINATION),
            path,
            message,
        );
    }
}

#[test]
fn detects_pool_resolver_and_mixed_cycles_including_other_pool_entries() {
    let base = "schema_version: 2\nitems: [draw_count, target, gift, token]\n";
    for (body, cycle) in [
        ("pools: [{main: [{weight: 1}, {weight: 1, actions: draw main}]}]", "pool main -> pool main"),
        ("pools: [{a: [{weight: 1, actions: draw b}]}, {b: [{weight: 1, actions: draw a}]}]", "pool a -> pool b -> pool a"),
        ("pools: [{main: [{weight: 1, actions: gift += 1}]}]\nitem_resolve: [{item: gift, retain: 0, actions: [gift -= 1, draw main]}]",
        "pool main -> resolve gift -> pool main"),
        ("pools: [{main: [{weight: 1}]}]\nitem_resolve: [{item: gift, retain: 0, actions: [gift -= 1, token = 1]}, {item: token, retain: 0, actions: [token -= 1, gift += 1]}]",
        "resolve gift -> resolve token -> resolve gift"),
    ] {
        rejected(compile(&format!("{base}{body}"), TERMINATION), "config", cycle);
    }
    let acyclic = format!(
        "{base}pools:
- main: [{{probability: 1, actions: gift += 1}}]
- next: [{{probability: 1, actions: [terminate stop, draw main]}}]
item_resolve:
- {{item: gift, retain: 0, actions: [gift -= 1, draw next]}}
"
    );
    compile(&acyclic, TERMINATION).unwrap();
}

#[test]
fn repeat_accounts_for_transitive_writes_and_ignores_unreachable_ones() {
    let config = "schema_version: 2
items: [draw_count, target, token]
pools:
- main: [{probability: 1, actions: draw nested}]
- nested: [{weight: 1}, {weight: 1, actions: token += 1}]
item_resolve:
- {item: token, retain: 0, actions: [token -= 1, target += 1]}
";
    for action in ["draw main", "draw nested", "token += 1", "token = 1"] {
        let rule = repeat(&format!(
            "{{check: target >= 1, actions: [{action}, target -= 1]}}"
        ));
        rejected(
            compile(&format!("{config}{rule}"), TERMINATION),
            "config.rules[0].r.condition.actions",
            "nested pool or item resolver may write checked item: target",
        );
    }
    let rule = repeat("{check: target >= 1, actions: [draw main, target -= 1]}");
    let safe = config.replace(
        "token -= 1, target += 1",
        "token -= 1, terminate early, target += 1",
    );
    compile(&format!("{safe}{rule}"), TERMINATION).unwrap();
    let directly_terminates = repeat("{check: target >= 1, actions: [draw main, terminate done]}");
    compile(&format!("{config}{directly_terminates}"), TERMINATION).unwrap();
}

#[test]
fn repeated_call_edges_preserve_repeat_reachability_and_runtime_actions() {
    let call_count = 50_000;
    let guard_count = 1000;
    let guards = (0..guard_count)
        .map(|i| format!("g{i}"))
        .collect::<Vec<_>>();
    let items = guards.join(", ");
    let writes = guards
        .iter()
        .map(|id| format!("{id} += 1"))
        .collect::<Vec<_>>()
        .join(", ");
    let calls = "draw nested, ".repeat(call_count);
    let mut config = format!(
        "schema_version: 2
items: [draw_count, target, {items}]
pools:
- main:
  - {{weight: 1, actions: [{calls}draw safe]}}
  - {{weight: 1, actions: draw nested}}
- nested: [{{weight: 1, actions: draw leaf}}]
- leaf: [{{weight: 1, actions: [{writes}, target += 1]}}]
- safe: [{{weight: 1, actions: [terminate early, draw main]}}]
rules:
"
    );
    use std::fmt::Write;
    for guard in &guards {
        writeln!(config, "- {guard}: {{mode: repeat, condition: {{check: {guard} >= 1, actions: [draw safe, {guard} -= 1]}}}}").unwrap();
    }
    assert!(config.len() < YAML_TEXT_LIMIT);
    let program = compile(&config, TERMINATION).unwrap();
    assert_eq!(program.rules.len(), guard_count);
    let actions = program.pool_entries[0]
        .actions
        .get(&program.actions)
        .unwrap();
    assert_eq!(actions.len(), call_count + 1);
    assert!(actions[..call_count]
        .iter()
        .all(|action| *action == Action::Draw { pool: 1 }));

    config.push_str("- bad: {mode: repeat, condition: {check: target >= 1, actions: [draw main, target -= 1]}}\n");
    rejected(
        compile(&config, TERMINATION),
        &format!("config.rules[{guard_count}].bad.condition.actions"),
        "nested pool or item resolver may write checked item: target",
    );
}

#[test]
fn checks_long_acyclic_resolver_chains_iteratively() {
    let count = 10_000;
    let mut items = vec!["draw_count".to_string(), "target".into(), "guard".into()];
    items.extend((0..count).map(|i| format!("i{i}")));
    let mut config = format!("schema_version: 2\nitems: [{}]\npools: [{{main: [{{probability: 1, actions: i0 += 1}}]}}]\nitem_resolve:\n", items.join(", "));
    use std::fmt::Write;
    for i in 0..count {
        let next = if i + 1 == count {
            "target".into()
        } else {
            format!("i{}", i + 1)
        };
        writeln!(
            config,
            "- item: i{i}\n  retain: 0\n  actions: [i{i} -= 1, {next} += 1]"
        )
        .unwrap();
    }
    config.push_str(&repeat(
        "{check: guard >= 1, actions: [draw main, guard -= 1]}",
    ));
    assert!(config.len() < YAML_TEXT_LIMIT);
    assert_eq!(
        compile(&config, TERMINATION)
            .unwrap()
            .item_resolves
            .iter()
            .flatten()
            .count(),
        count
    );
}

#[test]
fn normalizes_terminate_reasons_using_javascript_whitespace() {
    let config = format!(
        "{CONFIG}initial: {}\n",
        json!([
            "terminate \u{feff}first\u{feff} \u{feff}second\u{feff}",
            "terminate first second",
            "terminate \u{85}first\u{85}second\u{85}",
        ])
    );
    let program = compile(&config, TERMINATION).unwrap();
    assert_eq!(
        program.reasons,
        ["done", "first second", "\u{85}first\u{85}second\u{85}"]
    );
    assert_eq!(
        program.initial.get(&program.actions).unwrap(),
        [
            Action::Terminate { reason: 1 },
            Action::Terminate { reason: 1 },
            Action::Terminate { reason: 2 }
        ],
    );
}

#[test]
fn sorts_normalized_reasons_and_remaps_all_terminate_actions() {
    let config = CONFIG.replace(
        "actions: target += 1",
        "actions: [terminate z, terminate 甲, terminate a]",
    );
    let escaped = json!(["terminate é", "terminate first\n  second", "terminate a"]);
    let config = format!("{config}initial: {escaped}\n");
    let termination = TERMINATION.replace("terminate done", "terminate z");
    let program = compile(&config, &termination).unwrap();
    assert_eq!(program.reasons, ["a", "first second", "z", "é", "甲"]);
    let actual = program
        .actions
        .iter()
        .filter_map(|action| match *action {
            Action::Terminate { reason } => Some(program.reasons[reason as usize].as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(actual, ["z", "甲", "a", "é", "first second", "a", "z"]);
}

#[test]
fn batch_validates_the_combined_reason_limit_after_deduplication() {
    use gachasimulate_types::MAX_REASONS;

    let reasons = (0..MAX_REASONS)
        .map(|reason| format!("terminate {reason:x}"))
        .collect::<Vec<_>>()
        .join(",");
    let config = format!("{CONFIG}initial: [{reasons}]\n");
    let reused = TERMINATION.replace("terminate done", "terminate 0");
    let error = validate_config_files(
        &config,
        &[
            term("reused.yaml", &reused),
            term("overflow.yaml", TERMINATION),
        ],
    )
    .unwrap_err();
    assert_eq!(error.failed_files, ["overflow.yaml"]);
    assert_eq!(error.diagnostics[0].path, "reasons");
    assert_eq!(
        compile(&config, &reused).unwrap().reasons.len(),
        MAX_REASONS
    );
    rejected(
        compile(&config, TERMINATION),
        "reasons",
        "invalid reason count",
    );
}

fn term(file: &str, content: &str) -> TerminationSource {
    TerminationSource {
        file: file.into(),
        content: content.into(),
    }
}

#[test]
fn batch_errors_follow_input_order_and_snapshot_selects_only_manifest_terminations() {
    let first = TERMINATION
        .replace("[]", "[{target: 5}]")
        .replace("done", "first");
    let bad_field = format!("{TERMINATION}unknown: true\n");
    let bad_check = TERMINATION
        .replace("target >= 1", "missing >= 1")
        .replace("done", "invalid");
    let cases = [
        term("first.yaml", &first),
        term("bad-field.yaml", &bad_field),
        term("bad-check.yaml", &bad_check),
        term("termination.yaml", TERMINATION),
    ];
    let error = validate_config_files(CONFIG, &cases).unwrap_err();
    assert_eq!(error.failed_files, ["bad-field.yaml", "bad-check.yaml"]);
    assert_eq!(error.diagnostics.len(), 2);
    assert_eq!(error.diagnostics[0].path, "termination.unknown");
    assert_eq!(
        error.diagnostics[1].path,
        "termination.termination_rule.condition.check"
    );
    validate_config_files(CONFIG, &[]).unwrap();
    let invalid = CONFIG.replace("every_draw: draw_count += 1", "every_draw: missing += 1");
    let error = validate_config_files(&invalid, &cases).unwrap_err();
    assert_eq!(error.failed_files, ["config.yaml"]);
    assert_eq!(error.diagnostics[0].path, "config.every_draw[0]");

    let mut snapshot = ConfigSnapshot {
        manifest_yaml: MANIFEST.into(),
        config_yaml: CONFIG.into(),
        terminations: cases.into(),
    };
    rejected(
        compile_snapshot(&snapshot, "first.yaml", "target"),
        "termination_file",
        "not listed",
    );
    let selected = compile_snapshot(&snapshot, "termination.yaml", "target").unwrap();
    assert_eq!(selected.items[selected.result_item as usize].id, "target");
    assert_eq!(selected.reasons, ["done"]);
    snapshot.terminations.pop();
    rejected(
        compile_snapshot(&snapshot, "termination.yaml", "target"),
        "termination_file",
        "missing from config snapshot",
    );
    snapshot.manifest_yaml = "id: test\n".into();
    rejected(
        compile_snapshot(&snapshot, "termination.yaml", "target"),
        "manifest.name",
        "non-empty",
    );
}

#[test]
fn preserves_float_safe_integers_bool_identifier_keys_and_rejects_omap_lists() {
    let config = "\
schema_version: 2.0
items:
  - draw_count: 抽数
  - true: Lucky
pools:
  - false:
      - probability: 1
        actions: true += 1
item_resolve:
  - item: 'true'
    retain: 1.0
    actions: true -= 1
every_draw: draw_count += 1
";
    let termination = "\
retained_items:
  - true: 2e0
termination_rule:
  condition:
    check: true >= 1
    actions: terminate done
";
    let program = compile(config, termination).unwrap();
    assert_eq!(program.items[1].id, "true");
    assert_eq!(program.items[1].name, "Lucky");
    assert_eq!(program.pools[0].id, "false");
    assert_eq!(program.item_resolves[1].unwrap().retain, 2);

    // Duplicate effective key between unquoted bool and quoted string is rejected.
    let dup_key = config.replace("- true: Lucky", "- {true: Lucky, \"true\": Dup}");
    rejected(
        compile(&dup_key, termination),
        "config.items[1]",
        "duplicate",
    );

    // Fractional float in retain is still rejected.
    let bad_retain = config.replace("retain: 1.0", "retain: 1.5");
    rejected(
        compile(&bad_retain, termination),
        "config.item_resolve[0].retain",
        "safe integer",
    );

    // !!omap is rejected where schema requires a list.
    let omap_items = config.replace(
        "items:\n  - draw_count: 抽数\n  - true: Lucky",
        "items: !!omap [{draw_count: 抽数}]",
    );
    rejected(
        compile(&omap_items, termination),
        "config.items",
        "must be a list",
    );
}

#[test]
fn alternating_repeat_guards_reuse_reachability_without_scanning_unrelated_chains() {
    let mut config = String::from(
        "schema_version: 2\nitems: [a, b]\npools:\n- unrelated:\n  - probability: 1\n",
    );
    for i in 0..500 {
        config.push_str(&format!("- chain_{i}:\n  - probability: 1\n"));
        if i + 1 < 500 {
            config.push_str(&format!("    actions: draw chain_{}\n", i + 1));
        } else {
            config.push_str("    actions: [a += 1, b += 1]\n");
        }
    }
    config.push_str("rules:\n");
    for i in 0..200 {
        let item = if i % 2 == 0 { "a" } else { "b" };
        config.push_str(&format!(
            "- r_{i}: {{mode: repeat, condition: {{check: {item} >= 1, actions: [draw unrelated, {item} -= 1]}}}}\n"
        ));
    }
    let termination = "retained_items: []\ntermination_rule:\n  condition:\n    check: a >= 1\n    actions: terminate done\n";
    let program = compile_yaml(&config, termination, MANIFEST, "a").unwrap();
    assert_eq!(program.rules.len(), 200);
}
