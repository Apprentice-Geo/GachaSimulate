use std::fmt::Debug;

use gachasimulate_desktop_contract::*;
use gachasimulate_types::{fixtures, SimulationOptions};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

const REQUEST: &str = include_str!("../fixtures/simulation-request.json");
const EVENTS: &str = include_str!("../fixtures/simulation-events.json");
const REPOSITORY: &str = include_str!("../fixtures/config-repository-state.json");
const CANDIDATE: &str = include_str!("../fixtures/result-candidate-large-total.json");
const SAVE_REQUEST: &str = include_str!("../fixtures/save-result-fields-request.json");
const SAVED_FIELDS: &str = include_str!("../fixtures/saved-result-fields.json");
const ERROR: &str = include_str!("../fixtures/desktop-error.json");

fn round_trip<T: DeserializeOwned + Serialize>(source: &str) -> T {
    let decoded: T = serde_json::from_str(source).unwrap();
    assert_eq!(
        serde_json::to_value(&decoded).unwrap(),
        serde_json::from_str::<Value>(source).unwrap()
    );
    decoded
}

fn assert_unknown_fields_denied<T: DeserializeOwned + Debug>(value: Value, field: &str) {
    let mut value = value;
    value
        .as_object_mut()
        .unwrap()
        .insert(field.into(), Value::Null);
    let error = serde_json::from_value::<T>(value).unwrap_err();
    assert!(error.to_string().contains("unknown field"), "{error}");
}

#[test]
fn repository_round_trips_both_sources_of_the_same_config() {
    let state: ConfigRepositoryState = round_trip(REPOSITORY);
    let official = &state.official[0];
    let local = &state.local_configs[0];
    assert_eq!(official.status, RepositoryConfigStatus::Installed);
    assert_eq!(local.source, ConfigSource::Local);
    assert_eq!(official.id, local.id);
    assert_ne!(official.name, local.name);
    assert_eq!(
        state.official[1].status,
        RepositoryConfigStatus::UpdateAvailable
    );

    let mut value = serde_json::to_value(state).unwrap();
    value["localConfigs"][0]["items"][0]["path"] = json!("untrusted");
    assert!(serde_json::from_value::<ConfigRepositoryState>(value).is_err());
}

#[test]
fn simulation_request_round_trips_and_checks_ranges_and_selectors() {
    let request: SimulationCommandRequest = round_trip(REQUEST);
    request.validate(2).unwrap();
    let base = serde_json::to_value(&request).unwrap();
    for (field, invalid) in [
        ("totalRuns", json!(0)),
        ("totalRuns", json!(MAX_RUNS + 1)),
        ("threads", json!(0)),
        ("threads", json!(257)),
        ("configId", json!("../example")),
        ("configId", json!("nul")),
        ("configId", json!("a".repeat(65))),
        ("termination", json!("../termination.yaml")),
        ("termination", json!(r"C:\config\termination.yaml")),
        ("termination", json!("termination.yaml:alternate")),
        ("termination", json!("COM¹.yaml")),
        ("termination", json!("..")),
        ("termination", json!("termination.yaml ")),
        ("termination", json!("termination\0.yaml")),
        ("resultItem", json!("9score")),
        ("resultItem", json!("draw-count")),
        ("seed", json!(i64::MIN)),
    ] {
        let mut value = base.clone();
        value[field] = invalid;
        let request: SimulationCommandRequest = serde_json::from_value(value).unwrap();
        assert_eq!(
            request.validate(512).unwrap_err().code,
            DesktopErrorCode::InvalidRequest,
            "{field}"
        );
    }
    assert_eq!(
        request.validate(1).unwrap_err().code,
        DesktopErrorCode::InvalidRequest
    );
    assert_eq!(
        request.validate(0).unwrap_err().code,
        DesktopErrorCode::InvalidRequest
    );
    SimulationCommandRequest {
        threads: 256,
        total_runs: MAX_RUNS,
        ..request
    }
    .validate(512)
    .unwrap();
    assert_unknown_fields_denied::<SimulationCommandRequest>(base, "path");
    assert!(serde_json::from_value::<SimulationCommandRequest>(json!([
        "local",
        "example",
        "termination.yaml",
        "score",
        2,
        123,
        2
    ]))
    .is_err());
    assert_unknown_fields_denied::<CancelSimulationRequest>(json!({"taskId": 41}), "seq");
    assert!(serde_json::from_value::<CancelSimulationRequest>(json!({})).is_err());
    assert!(serde_json::from_value::<CancelSimulationRequest>(json!({"taskId": null})).is_err());
    assert!(serde_json::from_value::<CancelSimulationRequest>(json!([41])).is_err());
    let cancel: CancelSimulationRequest = serde_json::from_value(json!({"taskId": 41})).unwrap();
    cancel.validate().unwrap();
    assert_eq!(cancel.task_id, 41);
    assert_eq!(
        CancelSimulationRequest { task_id: 0 }
            .validate()
            .unwrap_err()
            .code,
        DesktopErrorCode::InvalidRequest
    );
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EventFixtures {
    cancel_race: CancelRace,
    page_switch: PageSwitch,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelRace {
    before_cancel: [SimulationTaskEvent; 3],
    late_events: [SimulationTaskEvent; 2],
    cancellation_events: [SimulationTaskEvent; 4],
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageSwitch {
    new_task_start: SimulationTaskEvent,
    snapshot: SimulationTaskSnapshot,
    deliveries: Vec<Delivery>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Delivery {
    event: SimulationTaskEvent,
    applied: bool,
}

#[test]
fn cancellation_wins_before_commit_and_keeps_slot_through_cleanup_retry() {
    let fixtures: EventFixtures = round_trip(EVENTS);
    let mut host = SimulationTaskStateMachine::new();
    let task = 41;
    let race = fixtures.cancel_race;
    let before = [
        host.start(task, 2).unwrap(),
        host.set_stage(task, SimulationStage::Simulating).unwrap(),
        host.progress(task, 1, 2).unwrap(),
    ];
    assert_eq!(before, race.before_cancel);
    assert!(!host.can_commit(task, 1, "9007199254740993", "fixed-example.gsr"));
    assert!(!host.can_commit(task, 2, "18446744073709551616", "fixed-example.gsr"));
    assert!(!host.can_commit(task, 2, "9007199254740993", "../escape.gsr"));
    assert!(host.can_commit(task, 2, "9007199254740993", "fixed-example.gsr"));
    assert_eq!(
        host.request_cancel(task).unwrap(),
        race.cancellation_events[0]
    );
    assert!(!host.can_commit(task, 2, "9007199254740993", "fixed-example.gsr"));

    let late_progress = &race.late_events[0].snapshot;
    assert_eq!(
        host.progress(task, late_progress.completed_runs, late_progress.total_runs),
        None
    );
    let late_success = &race.late_events[1].snapshot;
    assert_eq!(
        host.complete(
            task,
            late_success.total_runs,
            late_success.total_result.clone().unwrap(),
            late_success.result_filename.clone().unwrap()
        ),
        None,
    );
    assert_eq!(host.set_stage(task, SimulationStage::Saving), None);
    assert_eq!(host.fail(task, "late worker error".into()), None);
    assert_eq!(
        host.start(42, 2).unwrap_err().code,
        DesktopErrorCode::Conflict
    );

    let blocked: DesktopError = round_trip(ERROR);
    assert_eq!(blocked.code, DesktopErrorCode::CleanupBlocked);
    assert_eq!(
        host.cancel_retryable(task, blocked.message).unwrap(),
        race.cancellation_events[1]
    );
    assert_eq!(
        host.start(42, 2).unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(
        host.request_cancel(task).unwrap(),
        race.cancellation_events[2]
    );
    assert_eq!(host.cancelled(task).unwrap(), race.cancellation_events[3]);

    let page = fixtures.page_switch;
    assert_eq!(host.start(42, 2).unwrap(), page.new_task_start);
    assert_eq!(
        host.set_stage(42, SimulationStage::Simulating)
            .unwrap()
            .snapshot,
        page.snapshot
    );
    assert_eq!(host.progress(task, 2, 2), None);
    assert_eq!(
        host.request_cancel(task).unwrap_err().code,
        DesktopErrorCode::NotFound
    );
    assert_eq!(host.progress(42, 1, 2).unwrap(), page.deliveries[2].event);
    assert_eq!(host.progress(42, 1, 2), None);
    assert_eq!(
        host.set_stage(42, SimulationStage::Saving).unwrap(),
        page.deliveries[5].event
    );
    let success = &page.deliveries[6].event;
    assert_eq!(
        host.complete(42, 2, "9007199254740993".into(), "fixed-example.gsr".into())
            .unwrap(),
        *success,
    );
    assert_eq!(
        host.request_cancel(42).unwrap_err().code,
        DesktopErrorCode::Conflict
    );
}

#[test]
fn failed_simulation_keeps_its_outcome_and_task_slot_through_cleanup_retries() {
    let mut host = SimulationTaskStateMachine::new();
    let task = 41;
    let failure = "Simulation worker exited unsuccessfully";
    host.start(task, 2).unwrap();
    host.set_stage(task, SimulationStage::Simulating).unwrap();

    let blocked = host
        .fail_cleanup_retryable(task, failure.into(), "Worker cleanup timed out".into())
        .unwrap();
    assert_eq!(blocked.snapshot.status, SimulationStatus::Cancelling);
    assert!(blocked.snapshot.cancel_retryable);
    let message = blocked.snapshot.message.as_deref().unwrap();
    assert!(message.contains(failure));
    assert!(message.contains("Worker cleanup timed out"));
    assert_eq!(host.snapshot().task_id, Some(task));
    assert_eq!(
        host.start(42, 2).unwrap_err().code,
        DesktopErrorCode::Conflict
    );
    assert_eq!(host.cancelled(task), None);

    let retry = host.request_cancel(task).unwrap();
    assert_eq!(retry.snapshot.status, SimulationStatus::Cancelling);
    assert!(!retry.snapshot.cancel_retryable);
    assert_eq!(host.cancelled(task), None);
    assert_eq!(host.finish_cleanup(42), None);
    let blocked_again = host
        .cancel_retryable(task, "File is still locked".into())
        .unwrap();
    assert!(blocked_again.snapshot.cancel_retryable);
    assert!(blocked_again.snapshot.message.unwrap().contains(failure));
    host.request_cancel(task).unwrap();

    let failed = host.finish_cleanup(task).unwrap();
    assert_eq!(failed.snapshot.status, SimulationStatus::Failed);
    assert_eq!(failed.snapshot.message.as_deref(), Some(failure));
    assert!(!failed.snapshot.cancel_retryable);
    assert_eq!(host.finish_cleanup(task), None);
    assert_eq!(
        host.start(42, 2).unwrap().snapshot.status,
        SimulationStatus::Starting
    );
}

#[test]
fn candidate_uses_published_analysis_and_per_session_display_contract() {
    let candidate: ResultCandidateSession = round_trip(CANDIDATE);
    let expected: Analysis =
        serde_json::from_str(fixtures::large_total_results().analysis_json).unwrap();
    candidate.analysis.validate().unwrap();
    assert_eq!(candidate.analysis, expected);
    assert_eq!(candidate.analysis.totals.result, "9007199254740993");
    assert_eq!(
        candidate.display,
        DisplayConfig::for_missing_sidecar(expected.result_item.name)
    );
    assert_eq!(candidate.display.fields(), candidate.fields);
    candidate.validate().unwrap();

    let save: SaveResultFieldsRequest = round_trip(SAVE_REQUEST);
    let saved: SavedResultFields = round_trip(SAVED_FIELDS);
    assert_eq!(save.session_id, candidate.session_id);
    assert_eq!(saved.session_id, candidate.session_id);
    assert_eq!(saved.display, DisplayConfig::from_fields(save.fields));
    saved.display.validate().unwrap();
    let confirmation: ConfirmResultSessionRequest = round_trip(r#"{"sessionId":"session-42"}"#);
    let reply: ConfirmResultSessionResponse =
        round_trip(r#"{"confirmed":true,"activeSessionId":"session-42"}"#);
    assert_eq!(
        reply.active_session_id.as_deref(),
        Some(confirmation.session_id.as_str())
    );
    let discard: DiscardResultDraftRequest = round_trip(r#"{"sessionId":"session-42"}"#);
    assert_eq!(discard.session_id, confirmation.session_id);
    assert_unknown_fields_denied::<SaveResultFieldsRequest>(
        serde_json::from_str(SAVE_REQUEST).unwrap(),
        "path",
    );
    assert!(serde_json::from_value::<ConfirmResultSessionRequest>(json!(["session-42"])).is_err());
    assert!(serde_json::from_value::<DiscardResultDraftRequest>(json!(["session-42"])).is_err());
    assert!(serde_json::from_value::<SaveResultFieldsRequest>(json!([
        "session-42",
        ["t", "g", "n", "", "", ""]
    ]))
    .is_err());
    assert!(serde_json::from_value::<SaveResultFieldsRequest>(json!({
        "sessionId": "session-42",
        "fields": ["t", "g", "n", "", "", ""]
    }))
    .is_err());
}

#[test]
fn result_candidate_validation_rejects_invalid_display_and_mismatched_fields() {
    let mut candidate: ResultCandidateSession = round_trip(CANDIDATE);
    candidate.fields.note = "A different note".into();
    let mismatch = candidate.validate().unwrap_err();
    assert_eq!(mismatch.code, DesktopErrorCode::InvalidRequest);
    assert!(mismatch.message.contains("fields differ from display"));

    candidate.fields = candidate.display.fields();
    candidate.display.display_version = 1;
    assert_eq!(
        candidate.validate().unwrap_err().code,
        DesktopErrorCode::Sidecar
    );

    candidate.display.display_version = 2;
    candidate.analysis.totals.result = "not-a-number".into();
    assert_eq!(
        candidate.validate().unwrap_err().code,
        DesktopErrorCode::Analysis
    );

    let mut invalid_identity: ResultCandidateSession = round_trip(CANDIDATE);
    invalid_identity.filename = "../escape.gsr".into();
    assert_eq!(
        invalid_identity.validate().unwrap_err().code,
        DesktopErrorCode::InvalidRequest
    );
}

#[test]
fn missing_sidecar_uses_the_v032_default_note() {
    assert_eq!(
        DisplayConfig::for_missing_sidecar("积分").note,
        "MEAN 受极端值影响，P50 表示一半结果不超过该值，P95 表示 95% 结果不超过该值。MIN、MAX 受模拟次数影响，不代表理论极限。"
    );
}

#[test]
fn sidecar_validates_schema_and_actual_utf8_byte_limits() {
    let mut display = DisplayConfig::for_missing_sidecar("积分");
    display.note.clear();
    let compact = serde_json::to_vec(&display).unwrap();
    display.note = "字".repeat((DISPLAY_CONFIG_JSON_BYTE_LIMIT - compact.len()) / 3);
    display
        .note
        .push_str(&" ".repeat((DISPLAY_CONFIG_JSON_BYTE_LIMIT - compact.len()) % 3));
    assert_eq!(
        serde_json::to_vec(&display).unwrap().len(),
        DISPLAY_CONFIG_JSON_BYTE_LIMIT
    );
    display.validate().unwrap();
    display.note.push('字');
    assert_eq!(
        display.validate().unwrap_err().code,
        DesktopErrorCode::Sidecar
    );

    let mut padded = compact;
    padded.resize(DISPLAY_CONFIG_JSON_BYTE_LIMIT, b' ');
    DisplayConfig::from_sidecar_json(&padded).unwrap();
    padded.push(b' ');
    assert!(DisplayConfig::from_sidecar_json(&padded).is_err());

    for invalid in [
        json!({"display_version": 1, "title": "", "target": "", "result_item_name": "积分", "note": "", "subtitle": "", "result_item_unit": ""}),
        json!({"display_version": 2, "title": "", "target": "", "result_item_name": "", "note": "", "subtitle": "", "result_item_unit": ""}),
        json!({"display_version": 2, "title": "", "target": "", "result_item_name": "积分", "note": "", "subtitle": ""}),
        json!({"display_version": 2, "title": "", "target": "", "result_item_name": "积分", "note": "", "subtitle": "", "result_item_unit": "", "analysis": {}}),
        json!([2, "title", "target", "积分", "", "", ""]),
    ] {
        assert!(DisplayConfig::from_sidecar_json(&serde_json::to_vec(&invalid).unwrap()).is_err());
    }
    let fractional_spelling = br#"{"display_version":2.0,"title":"","target":"","result_item_name":"score","note":"","subtitle":"","result_item_unit":""}"#;
    DisplayConfig::from_sidecar_json(fractional_spelling).unwrap();
}

#[test]
fn worker_job_serializes_the_same_owned_snapshot_and_options() {
    let snapshot = fixtures::config_package().snapshot;
    let resolved = ResolvedConfigSnapshot {
        source: ConfigSource::Local,
        config_id: "example".into(),
        snapshot: snapshot.clone(),
    };
    let _: ResolvedConfigSnapshot = round_trip(&serde_json::to_string(&resolved).unwrap());
    let options = SimulationOptions {
        total_runs: 2,
        seed: -42,
        threads: 2,
        chunk_size: Some(1),
        max_in_flight_chunks: None,
    };
    let job = WorkerSimulationJob {
        snapshot,
        termination_file: "termination.yaml".into(),
        result_item: "score".into(),
        options: options.clone().into(),
        temp_output_path: r"C:\Results\.session-42.tmp".into(),
    };
    let value = serde_json::to_value(&job).unwrap();
    assert_eq!(
        value["snapshot"]["manifestYaml"],
        resolved.snapshot.manifest_yaml
    );
    assert_eq!(value["terminationFile"], job.termination_file);
    assert_eq!(
        value["options"],
        json!({"totalRuns": 2, "seed": -42, "threads": 2, "chunkSize": 1, "maxInFlightChunks": null})
    );
    let decoded: WorkerSimulationJob = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(decoded, job);
    assert_eq!(SimulationOptions::from(decoded.options), options);
    let mut invalid = value;
    invalid["snapshot"]["terminations"][0]["path"] = json!("untrusted");
    assert!(serde_json::from_value::<WorkerSimulationJob>(invalid).is_err());
}

#[test]
fn worker_events_and_desktop_snapshots_preserve_canonical_u64_totals() {
    for wire in [
        r#"{"type":"started"}"#,
        r#"{"type":"stage","stage":"loadingConfig"}"#,
        r#"{"type":"progress","completedRuns":1,"totalRuns":2}"#,
        r#"{"type":"completed","totalRuns":2,"totalResult":"9007199254740993","chunksWritten":2,"fileSize":256}"#,
        r#"{"type":"error","message":"disk full"}"#,
    ] {
        let _: WorkerSimulationEvent = round_trip(wire);
        assert_unknown_fields_denied::<WorkerSimulationEvent>(
            serde_json::from_str(wire).unwrap(),
            "taskId",
        );
    }

    let fixtures: EventFixtures = serde_json::from_str(EVENTS).unwrap();
    let snapshot = &fixtures.cancel_race.late_events[1].snapshot;
    for invalid in [
        json!("01"),
        json!("18446744073709551616"),
        json!(9007199254740993u64),
    ] {
        let mut event = json!({"type":"completed","totalRuns":2,"totalResult":invalid,"chunksWritten":2,"fileSize":256});
        assert!(serde_json::from_value::<WorkerSimulationEvent>(event.clone()).is_err());
        let mut value = serde_json::to_value(snapshot).unwrap();
        value["totalResult"] = event["totalResult"].take();
        assert!(serde_json::from_value::<SimulationTaskSnapshot>(value).is_err());
    }
    let mut invalid = snapshot.clone();
    invalid.total_result = Some("012".into());
    assert!(serde_json::to_value(invalid).is_err());
}
