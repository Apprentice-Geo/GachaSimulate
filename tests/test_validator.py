from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from gachasimulate.validator import (
    ValidationError,
    validate_config,
    validate_files,
    validate_termination,
)

ROOT = Path(__file__).resolve().parents[1]
CONFIG_SCHEMA_PATH = ROOT / "docs" / "schemas" / "config.schema.json"
TERMINATION_SCHEMA_PATH = ROOT / "docs" / "schemas" / "termination.schema.json"


def _config_termination_pairs() -> list[tuple[Path, Path]]:
    pairs: list[tuple[Path, Path]] = []
    for config_path in sorted((ROOT / "configs").glob("*/config.json")):
        for termination_path in sorted(config_path.parent.glob("termination*.json")):
            pairs.append((config_path, termination_path))
    return pairs


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _assert_matches_schema(instance_path: Path, schema_path: Path) -> None:
    schema = _load_json(schema_path)
    instance = _load_json(instance_path)
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(instance), key=lambda error: error.path)

    if errors:
        error = errors[0]
        path = ".".join(str(part) for part in error.absolute_path) or "<root>"
        pytest.fail(
            f"{instance_path.relative_to(ROOT)} does not match "
            f"{schema_path.relative_to(ROOT)} at {path}: {error.message}"
        )


@pytest.fixture
def test_config() -> dict:
    return _load_json(ROOT / "configs" / "test" / "config.json")


@pytest.fixture
def test_termination() -> dict:
    return _load_json(ROOT / "configs" / "test" / "termination.json")


def test_validates_test_configs(test_config: dict, test_termination: dict) -> None:
    validate_config(test_config)
    validate_termination(test_termination, test_config)


def test_validates_real_config_files() -> None:
    validate_files(
        str(ROOT / "configs" / "sunwukong_wuxiang" / "config.json"),
        str(ROOT / "configs" / "sunwukong_wuxiang" / "termination_skin.json"),
        str(CONFIG_SCHEMA_PATH),
        str(TERMINATION_SCHEMA_PATH),
    )


@pytest.mark.parametrize(
    "config_path",
    sorted((ROOT / "configs").glob("*/config.json")),
    ids=lambda path: path.parent.name,
)
def test_config_files_match_json_schema(config_path: Path) -> None:
    _assert_matches_schema(config_path, CONFIG_SCHEMA_PATH)


@pytest.mark.parametrize(
    "termination_path",
    sorted((ROOT / "configs").glob("*/termination*.json")),
    ids=lambda path: f"{path.parent.name}/{path.name}",
)
def test_termination_files_match_json_schema(termination_path: Path) -> None:
    _assert_matches_schema(termination_path, TERMINATION_SCHEMA_PATH)


@pytest.mark.parametrize(
    "config_path",
    sorted((ROOT / "configs").glob("*/config.json")),
    ids=lambda path: path.parent.name,
)
def test_config_directory_has_termination_files(config_path: Path) -> None:
    assert list(config_path.parent.glob("termination*.json"))


@pytest.mark.parametrize(
    ("config_path", "termination_path"),
    _config_termination_pairs(),
    ids=lambda value: value.parent.name if value.name == "config.json" else value.name,
)
def test_validates_all_real_config_files(config_path: Path, termination_path: Path) -> None:
    validate_files(
        str(config_path),
        str(termination_path),
        str(CONFIG_SCHEMA_PATH),
        str(TERMINATION_SCHEMA_PATH),
    )


def test_initial_begin_pool_may_reference_any_pool_order(test_config: dict) -> None:
    config = deepcopy(test_config)
    pools = config["pools"]
    config["pools"] = {"pool_1": pools["pool_1"]}
    config["pools"].update({key: value for key, value in pools.items() if key != "pool_1"})
    config["initial"]["begin_pool"] = "begin_pool"

    validate_config(config)


def test_requires_initial(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["initial"]

    with pytest.raises(ValidationError, match=r"config\.initial: must be an object"):
        validate_config(config)


def test_requires_draw_count_item(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["items"]["draw_count"]

    with pytest.raises(ValidationError, match=r"config\.items\.draw_count: is required"):
        validate_config(config)


def test_requires_every_draw(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["every_draw"]

    with pytest.raises(ValidationError, match=r"config\.every_draw: must be an array"):
        validate_config(config)


def test_requires_every_draw_to_increment_draw_count(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["every_draw"] = [{"type": "add_item", "id": "general_fragment", "amount": 1}]

    with pytest.raises(
        ValidationError,
        match="config.every_draw: must include add_item action for draw_count",
    ):
        validate_config(config)


def test_requires_known_initial_begin_pool(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["initial"]["begin_pool"] = "missing_pool"

    with pytest.raises(ValidationError, match="unknown pool id: missing_pool"):
        validate_config(config)


def test_rejects_empty_pools(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"] = {}

    with pytest.raises(ValidationError, match="config.pools: must be non-empty"):
        validate_config(config)


def test_rejects_unknown_action_type(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"][0]["type"] = "noop"

    with pytest.raises(ValidationError, match="unsupported action type: noop"):
        validate_config(config)


def test_rejects_action_unknown_item_reference(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"][0]["id"] = "missing_item"

    with pytest.raises(ValidationError, match="unknown item id: missing_item"):
        validate_config(config)


def test_rejects_action_unknown_pool_reference(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["random_precious_item"]["on_acquire"][0]["id"] = "missing_pool"

    with pytest.raises(ValidationError, match="unknown pool id: missing_pool"):
        validate_config(config)


def test_requires_predicate_id(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    del termination["termination_condition"]["conditions"][1]["conditions"][0]["id"]

    with pytest.raises(ValidationError, match=r"\.id: must be present"):
        validate_termination(termination, test_config)


def test_requires_termination_actions_inside_termination_tree(
    test_termination: dict, test_config: dict
) -> None:
    termination = deepcopy(test_termination)
    termination["termination_condition"]["conditions"][0]["actions"] = [
        {"type": "add_item", "id": "general_fragment", "amount": 1}
    ]

    with pytest.raises(
        ValidationError,
        match="termination tree actions must use type 'termination'",
    ):
        validate_termination(termination, test_config)


def test_requires_positive_integer_amount(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["ordinary_item_1"]["resolve"]["actions"][1]["amount"] = 0

    with pytest.raises(ValidationError, match="must be a positive integer"):
        validate_config(config)


def test_rejects_boolean_amount(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["ordinary_item_1"]["resolve"]["actions"][1]["amount"] = True

    with pytest.raises(ValidationError, match="must be a positive integer"):
        validate_config(config)


def test_requires_item_resolve_retain(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["items"]["ordinary_item_1"]["resolve"]["retain"]

    with pytest.raises(ValidationError, match=r"\.retain: is required"):
        validate_config(config)


def test_rejects_negative_item_resolve_retain(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["ordinary_item_1"]["resolve"]["retain"] = -1

    with pytest.raises(ValidationError, match="must be a non-negative integer"):
        validate_config(config)


def test_rejects_empty_item_on_acquire(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["random_ordinary_item"]["on_acquire"] = []

    with pytest.raises(ValidationError, match="must be a non-empty array"):
        validate_config(config)


def test_rejects_empty_item_resolve(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["ordinary_item_1"]["resolve"] = {}

    with pytest.raises(ValidationError, match="must be non-empty"):
        validate_config(config)


def test_requires_item_resolve_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["items"]["ordinary_item_1"]["resolve"]["actions"]

    with pytest.raises(ValidationError, match=r"\.actions: is required"):
        validate_config(config)


def test_rejects_empty_item_resolve_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["items"]["ordinary_item_1"]["resolve"]["actions"] = []

    with pytest.raises(ValidationError, match="must be a non-empty array"):
        validate_config(config)


def test_allows_zero_amount_for_set_item(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["every_draw"] = [
        {"type": "add_item", "id": "draw_count", "amount": 1},
        {"type": "set_item", "id": "general_fragment", "amount": 0},
    ]

    validate_config(config)


def test_rejects_negative_amount_for_set_item(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["every_draw"] = [
        {"type": "add_item", "id": "draw_count", "amount": 1},
        {"type": "set_item", "id": "general_fragment", "amount": -1},
    ]

    with pytest.raises(ValidationError, match="must be a non-negative integer"):
        validate_config(config)


def test_requires_pool_probabilities_to_sum_to_one(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["probability"] = 0.02

    with pytest.raises(ValidationError, match="probability sum must be 1"):
        validate_config(config)


def test_rejects_negative_pool_probability(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["probability"] = -0.01

    with pytest.raises(ValidationError, match="must be non-negative"):
        validate_config(config)


def test_allows_omitted_pool_entry_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["pools"]["begin_pool"]["entries"][0]["actions"]

    validate_config(config)


def test_rejects_null_pool_entry_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"] = None

    with pytest.raises(ValidationError, match="must be an array"):
        validate_config(config)


def test_rejects_empty_pool_entry_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"] = []

    with pytest.raises(ValidationError, match="must be a non-empty array"):
        validate_config(config)


def test_rejects_empty_condition_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["have_target_item_1"]["condition"]["actions"] = []

    with pytest.raises(ValidationError, match="must be a non-empty array"):
        validate_config(config)


def test_rejects_unknown_predicate_subject(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["have_target_item_1"]["condition"]["subject"] = "currency"

    with pytest.raises(ValidationError, match="unsupported predicate subject: currency"):
        validate_config(config)


def test_rejects_unknown_predicate_op(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["have_target_item_1"]["condition"]["op"] = "contains"

    with pytest.raises(ValidationError, match="unsupported predicate op: contains"):
        validate_config(config)


def test_rejects_draw_count_predicate_subject(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["have_target_item_1"]["condition"]["subject"] = "draw_count"

    with pytest.raises(
        ValidationError,
        match="unsupported predicate subject: draw_count",
    ):
        validate_config(config)


def test_rejects_unknown_item_predicate_id(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    termination["termination_condition"]["conditions"][0]["conditions"][0]["id"] = "missing_item"

    with pytest.raises(ValidationError, match="unknown item id: missing_item"):
        validate_termination(termination, test_config)


def test_rejects_unknown_logic_op(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    termination["termination_condition"]["op"] = "XOR"

    with pytest.raises(ValidationError, match="unsupported logic op: XOR"):
        validate_termination(termination, test_config)


def test_requires_non_empty_logic_conditions(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    termination["termination_condition"]["conditions"] = []

    with pytest.raises(ValidationError, match="must be non-empty"):
        validate_termination(termination, test_config)


def test_rejects_unknown_retained_item(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    termination["retained_items"].append("missing_item")

    with pytest.raises(ValidationError, match="unknown item id: missing_item"):
        validate_termination(termination, test_config)
