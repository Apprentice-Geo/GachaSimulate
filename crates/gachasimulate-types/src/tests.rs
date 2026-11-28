use serde_json::{json, Value};

use crate::{
    fixtures::{self, MemoryChunkWriter, ResultFixture},
    *,
};

#[test]
fn deterministic_program_has_valid_invariants() {
    fixtures::deterministic_program()
        .validate_invariants()
        .unwrap();
}

#[test]
fn rejects_invalid_program_indices_and_ranges() {
    let original = fixtures::deterministic_program();
    let mut program = original.clone();
    program.result_item = 1;
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidField {
            field: "result_item",
            ..
        })
    ));

    program = original.clone();
    program.actions[0] = Action::Draw { pool: 1 };
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidEntry {
            table: "actions",
            index: 0,
            ..
        })
    ));

    program = original.clone();
    program.initial = ActionRange::new(u32::MAX, 1);
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidField {
            field: "initial",
            ..
        })
    ));

    program = original;
    program.condition_children.push(1);
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidEntry {
            table: "condition_children",
            index: 0,
            ..
        })
    ));
}

#[test]
fn rejects_unsorted_duplicate_and_empty_reasons() {
    for reasons in [vec!["z", "a"], vec!["done", "done"], vec![""]] {
        let mut program = fixtures::deterministic_program();
        program.reasons = reasons.into_iter().map(String::from).collect();
        assert!(matches!(
            program.validate_invariants(),
            Err(ProgramInvariantError::InvalidEntry {
                table: "reasons",
                ..
            })
        ));
    }
}

#[test]
fn rejects_bad_and_non_increasing_thresholds() {
    let original = fixtures::deterministic_program();
    for threshold in [f64::NAN, f64::INFINITY, 0.0, 1.1, 0.9] {
        let mut program = original.clone();
        program.pool_entries[0].threshold = threshold;
        assert!(
            program.validate_invariants().is_err(),
            "accepted {threshold}"
        );
    }

    let mut program = original;
    program.pool_entries.push(program.pool_entries[0]);
    program.pools[0].entries.count = 2;
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidEntry {
            table: "pools",
            index: 0,
            ..
        })
    ));
}

#[test]
fn rejects_cyclic_or_excessively_deep_conditions() {
    let mut program = fixtures::deterministic_program();
    for index in 0..MAX_CONDITION_DEPTH {
        program.condition_children.push(index as u32);
        program.condition_nodes.push(ConditionNode::Logic {
            op: LogicOp::And,
            children: ActionRange::new(index as u32, 1),
            actions: ActionRange::EMPTY,
        });
    }
    let last = program.condition_nodes.pop().unwrap();
    program.validate_invariants().unwrap();
    program.condition_nodes.push(last);
    assert!(program.validate_invariants().is_err());

    program.condition_nodes.truncate(2);
    program.condition_children = vec![1];
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidEntry {
            table: "condition_nodes",
            index: 1,
            ..
        })
    ));
}

#[test]
fn resolver_matches_its_single_reduction() {
    let mut program = fixtures::deterministic_program();
    program
        .actions
        .push(Action::ReduceItem { item: 0, amount: 2 });
    program.item_resolves[0] = Some(ItemResolve {
        retain: 0,
        reduce_per_batch: 2,
        actions: ActionRange::new(4, 1),
    });
    program.validate_invariants().unwrap();
    for amount in [0, 1] {
        program.item_resolves[0].as_mut().unwrap().reduce_per_batch = amount;
        assert!(matches!(
            program.validate_invariants(),
            Err(ProgramInvariantError::InvalidEntry {
                table: "item_resolves",
                index: 0,
                ..
            })
        ));
    }
}

fn assert_analysis_fixture(fixture: &ResultFixture) -> Analysis {
    let analysis: Analysis = serde_json::from_str(fixture.analysis_json).unwrap();
    analysis.validate().unwrap();
    let serialized = serde_json::to_string(&analysis).unwrap();
    assert_eq!(
        serde_json::from_str::<Analysis>(&serialized).unwrap(),
        analysis
    );
    assert_eq!(analysis.result_item.id, fixture.meta.result_item_id);
    assert_eq!(analysis.result_item.name, fixture.meta.result_item_name);

    let mut chunks = Vec::new();
    let mut writer = MemoryChunkWriter::new(&fixture.meta, &mut chunks);
    for chunk in &fixture.chunks {
        writer.write_chunk(chunk).unwrap();
    }
    let summary = writer.finish().unwrap();
    assert_eq!(chunks, fixture.chunks);
    assert_eq!(summary.total_result.to_string(), analysis.totals.result);
    assert_eq!(summary.total_runs.to_string(), analysis.totals.runs);
    assert_eq!(summary.chunks_written, fixture.chunks.len() as u64);
    analysis
}

#[test]
fn known_analysis_round_trips_with_the_exact_statistic_keys() {
    let fixture = fixtures::known_results();
    let analysis = assert_analysis_fixture(&fixture);
    let serialized = serde_json::to_value(analysis).unwrap();
    let original: Value = serde_json::from_str(fixture.analysis_json).unwrap();
    assert_eq!(serialized["statistic"], original["statistic"]);
}

#[test]
fn analysis_accepts_total_above_js_safe_integer() {
    let analysis = assert_analysis_fixture(&fixtures::large_total_results());
    assert_eq!(analysis.totals.result, "9007199254740993");
    assert!(analysis
        .values
        .iter()
        .all(|value| value.parse::<u64>().unwrap() < (1 << 53)));
}

#[test]
fn rejects_inconsistent_analysis() {
    let fixture = fixtures::known_results();
    let original: Value = serde_json::from_str(fixture.analysis_json).unwrap();
    for (pointer, replacement, path) in [
        ("/totals/runs", json!("0"), "totals.runs"),
        ("/totals/result", json!("018"), "totals.result"),
        (
            "/totals/result",
            json!("18446744073709551616"),
            "totals.result",
        ),
        ("/result_item/id", json!("3score"), "result_item.id"),
        ("/values/1", json!("1"), "values[1]"),
        ("/values/1", json!("02"), "values[1]"),
        ("/cumulative/1", json!(0.2), "cumulative[1]"),
        ("/cumulative/2", json!(0.9), "cumulative"),
        ("/cumulative", json!([1]), "values"),
        ("/statistic/P5", json!("+2"), "statistic.P5"),
        ("/statistic/MEAN_LEVEL", json!(1.1), "statistic.MEAN_LEVEL"),
        (
            "/termination_reason/0/proportion",
            json!(35),
            "termination_reason",
        ),
        (
            "/termination_reason/0/proportion",
            json!(101),
            "termination_reason[0].proportion",
        ),
    ] {
        let mut value = original.clone();
        *value.pointer_mut(pointer).unwrap() = replacement;
        let analysis: Analysis = serde_json::from_value(value).unwrap();
        assert!(
            matches!(
                analysis.validate(),
                Err(AnalysisValidationError::InvalidField { path: actual, .. }) if actual == path
            ),
            "{pointer}"
        );
    }
}

#[test]
fn analysis_denies_unknown_fields_in_all_objects() {
    let original: Value = serde_json::from_str(fixtures::known_results().analysis_json).unwrap();
    for path in [
        "",
        "/result_item",
        "/totals",
        "/statistic",
        "/termination_reason/0",
    ] {
        let mut input = original.clone();
        input.pointer_mut(path).unwrap()["extra"] = json!(true);
        assert!(serde_json::from_value::<Analysis>(input).is_err(), "{path}");
    }
}

#[test]
fn analysis_enforces_the_compact_utf8_size_limit() {
    let mut analysis: Analysis =
        serde_json::from_str(fixtures::known_results().analysis_json).unwrap();
    analysis.result_item.name.clear();
    let remaining = MAX_ANALYSIS_JSON_BYTES - serde_json::to_vec(&analysis).unwrap().len();
    analysis.result_item.name = "\n".repeat(remaining / 2);
    if !remaining.is_multiple_of(2) {
        analysis.result_item.name.push('x');
    }
    analysis.validate().unwrap();
    analysis.result_item.name.push('x');
    assert!(matches!(
        analysis.validate(),
        Err(AnalysisValidationError::JsonSizeExceeded {
            limit: MAX_ANALYSIS_JSON_BYTES
        })
    ));
}

#[test]
fn config_fixture_keeps_snapshot_and_package_bytes_in_sync() {
    let package = fixtures::config_package();
    assert_eq!(
        package.index.format_version,
        CONFIG_REPOSITORY_FORMAT_VERSION
    );
    assert_eq!(package.index.configs[0].id, "example");
    assert_eq!(package.snapshot.terminations[0].file, "termination.yaml");
    assert!(package.snapshot.termination("Termination.yaml").is_none());
    assert_eq!(
        package
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        [MANIFEST_FILE, CONFIG_FILE, "termination.yaml"]
    );
    assert_eq!(package.files.len(), package.file_bytes.len());
    for (file, bytes) in package.files.iter().zip(&package.file_bytes) {
        assert_eq!(bytes.metadata(), *file);
        assert_eq!(
            package.snapshot.file(&file.path).unwrap().as_bytes(),
            bytes.bytes
        );
    }
}

#[test]
fn mock_writer_rejects_gaps_duplicates_and_bad_reason_indices() {
    let fixture = fixtures::known_results();
    let mut chunks = Vec::new();
    let mut writer = MemoryChunkWriter::new(&fixture.meta, &mut chunks);
    assert!(matches!(
        writer.write_chunk(&fixture.chunks[1]),
        Err(GsrError::OutOfOrderChunk {
            expected_start: 0,
            start_run: 2
        })
    ));
    writer.write_chunk(&fixture.chunks[0]).unwrap();
    assert!(matches!(
        writer.write_chunk(&fixture.chunks[0]),
        Err(GsrError::DuplicateChunk { start_run: 0 })
    ));
    let mut bad_chunk = fixture.chunks[1].clone();
    bad_chunk.records[0].reason_index = 3;
    assert!(matches!(
        writer.write_chunk(&bad_chunk),
        Err(GsrError::ReasonIndexOutOfBounds {
            run_index: 2,
            reason_index: 3,
            reason_count: 3
        })
    ));
    assert!(matches!(
        writer.finish(),
        Err(GsrError::MissingChunk { expected_start: 2 })
    ));
    assert_eq!(chunks, fixture.chunks[..1]);
}

#[test]
fn mock_writer_checks_total_overflow_without_accepting_the_chunk() {
    let fixture = fixtures::known_results();
    let mut chunks = Vec::new();
    let mut writer = MemoryChunkWriter::new(&fixture.meta, &mut chunks);
    let mut first = fixture.chunks[0].clone();
    first.records[0].value = u64::MAX - first.records[1].value;
    writer.write_chunk(&first).unwrap();
    let mut last = fixture.chunks[1].clone();
    assert!(matches!(
        writer.write_chunk(&last),
        Err(GsrError::ArithmeticOverflow {
            field: "total result"
        })
    ));
    last.records[0].value = 0;
    writer.write_chunk(&last).unwrap();
    assert_eq!(writer.finish().unwrap().total_result, u64::MAX);
    assert_eq!(chunks, [first, last]);
}

#[test]
fn cancelling_a_clone_updates_the_shared_token() {
    let token = CancelToken::new();
    assert!(!token.is_cancelled());
    std::thread::spawn({
        let token = token.clone();
        move || token.cancel()
    })
    .join()
    .unwrap();
    assert!(token.is_cancelled());
}

#[test]
fn mock_writer_rejects_oversized_chunk() {
    let meta = GsrHeaderMeta {
        total_runs: (MAX_CHUNK_RECORDS as u64) + 1,
        seed: 0,
        result_item_id: "score".into(),
        result_item_name: "积分".into(),
        reasons: vec!["done".into()],
    };
    let mut chunks = Vec::new();
    let mut writer = MemoryChunkWriter::new(&meta, &mut chunks);
    let oversized = ResultChunk {
        start_run: 0,
        records: vec![
            ResultRecord {
                value: 1,
                reason_index: 0,
            };
            MAX_CHUNK_RECORDS + 1
        ],
    };
    assert!(matches!(
        writer.write_chunk(&oversized),
        Err(GsrError::LimitExceeded {
            field: "chunk records",
            limit
        }) if limit == MAX_CHUNK_RECORDS as u64
    ));
    assert!(chunks.is_empty());
}

#[test]
fn manifest_metadata_preserves_non_json_yaml_values() {
    let manifest = ConfigManifest {
        id: "example".into(),
        name: "Example".into(),
        description: String::new(),
        terminations: vec![ConfigTermination {
            file: "termination.yaml".into(),
            name: "Done".into(),
        }],
        metadata: Some(YamlValue::Mapping(vec![
            (YamlValue::String("inf".into()), YamlValue::Infinity),
            (YamlValue::String("neg_inf".into()), YamlValue::NegInfinity),
            (YamlValue::String("nan".into()), YamlValue::Nan),
            (
                YamlValue::String("huge_float".into()),
                YamlValue::Float("1.0e+400".into()),
            ),
            (
                YamlValue::Integer("1".into()),
                YamlValue::String("int_key".into()),
            ),
            (
                YamlValue::String("huge_int".into()),
                YamlValue::Integer("170141183460469231731687303715884105728".into()),
            ),
            (
                YamlValue::String("bin".into()),
                YamlValue::Tagged {
                    tag: "tag:yaml.org,2002:binary".into(),
                    value: Box::new(YamlValue::String("SGVsbG8=".into())),
                },
            ),
            (
                YamlValue::String("set".into()),
                YamlValue::Tagged {
                    tag: "tag:yaml.org,2002:set".into(),
                    value: Box::new(YamlValue::Mapping(vec![(
                        YamlValue::String("one".into()),
                        YamlValue::Null,
                    )])),
                },
            ),
        ])),
    };
    let Some(YamlValue::Mapping(entries)) = manifest.metadata else {
        panic!("expected mapping metadata");
    };
    assert_eq!(entries.len(), 8);
    assert_eq!(entries[0].1, YamlValue::Infinity);
    assert_eq!(entries[1].1, YamlValue::NegInfinity);
    assert_eq!(entries[2].1, YamlValue::Nan);
    assert_eq!(entries[3].1, YamlValue::Float("1.0e+400".into()));
    assert_eq!(entries[4].0, YamlValue::Integer("1".into()));
    assert_eq!(
        entries[5].1,
        YamlValue::Integer("170141183460469231731687303715884105728".into())
    );
    assert!(matches!(
        &entries[6].1,
        YamlValue::Tagged { tag, value }
            if tag == "tag:yaml.org,2002:binary"
                && matches!(value.as_ref(), YamlValue::String(s) if s == "SGVsbG8=")
    ));
    assert!(matches!(
        &entries[7].1,
        YamlValue::Tagged { tag, value }
            if tag == "tag:yaml.org,2002:set"
                && matches!(value.as_ref(), YamlValue::Mapping(items) if items.len() == 1)
    ));
}

#[test]
fn integral_json_float_spellings_are_accepted_where_schema_allows() {
    let mut index_value: Value = serde_json::from_str(fixtures::EXAMPLE_INDEX_JSON).unwrap();
    index_value["format_version"] = json!(1.0);
    let parsed_index: ConfigRepositoryIndex = serde_json::from_value(index_value.clone()).unwrap();
    assert_eq!(parsed_index.format_version, 1);

    index_value["format_version"] = json!(1.5);
    assert!(serde_json::from_value::<ConfigRepositoryIndex>(index_value).is_err());

    let mut analysis_value: Value =
        serde_json::from_str(fixtures::known_results().analysis_json).unwrap();
    analysis_value["termination_reason"][0]["proportion"] = json!(34.0);
    let parsed_analysis: Analysis = serde_json::from_value(analysis_value.clone()).unwrap();
    parsed_analysis.validate().unwrap();
    assert_eq!(parsed_analysis.termination_reason[0].proportion, 34);

    analysis_value["termination_reason"][0]["proportion"] = json!(34.5);
    assert!(serde_json::from_value::<Analysis>(analysis_value).is_err());
}

#[test]
fn header_meta_derives_from_program_and_matches_writer() {
    let program = fixtures::deterministic_program();
    let options = SimulationOptions {
        total_runs: 10,
        seed: 42,
        threads: 2,
        chunk_size: None,
        max_in_flight_chunks: None,
    };
    let meta = GsrHeaderMeta::from_program(&program, &options).unwrap();
    assert_eq!(meta.total_runs, 10);
    assert_eq!(meta.seed, 42);
    assert_eq!(meta.result_item_id, "score");
    assert_eq!(meta.result_item_name, "积分");
    assert_eq!(meta.reasons, vec!["done"]);

    let mut chunks = Vec::new();
    let writer = MemoryChunkWriter::new(&meta, &mut chunks);
    assert_eq!(writer.metadata(), &meta);
}

#[test]
fn program_rejects_reasons_exceeding_gsr_header_metadata_budget() {
    let mut program = fixtures::deterministic_program();
    // 64 distinct 1 MiB reasons plus fixed header, item ID/name, and u32
    // length prefixes exceed MAX_GSR_METADATA_BYTES (64 MiB).
    program.reasons = (0..64)
        .map(|index| format!("{index:02}{}", "r".repeat(MAX_STRING_BYTES - 2)))
        .collect();
    assert!(matches!(
        program.validate_invariants(),
        Err(ProgramInvariantError::InvalidField {
            field: "reasons",
            ..
        })
    ));
}
