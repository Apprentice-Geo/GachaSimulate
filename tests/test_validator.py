from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path

import pytest

from gacha_sim.core.validator import ValidationError, validate_config, validate_files, validate_termination

ROOT = Path(__file__).resolve().parents[1]


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


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
    )


def test_requires_begin_pool_as_first_pool(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"] = {
        "pool_1": config["pools"]["pool_1"],
        "begin_pool": config["pools"]["begin_pool"],
    }

    with pytest.raises(ValidationError, match="first pool must be named 'begin_pool'"):
        validate_config(config)


def test_requires_explicit_null_id_for_non_item_predicate(test_termination: dict, test_config: dict) -> None:
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
    config["item_resolve"]["ordinary_item_1"]["actions"][1]["amount"] = 0

    with pytest.raises(ValidationError, match="must be a positive integer"):
        validate_config(config)


def test_requires_item_resolve_retain(test_config: dict) -> None:
    config = deepcopy(test_config)
    del config["item_resolve"]["ordinary_item_1"]["retain"]

    with pytest.raises(ValidationError, match=r"\.retain: is required"):
        validate_config(config)


def test_rejects_negative_item_resolve_retain(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["item_resolve"]["ordinary_item_1"]["retain"] = -1

    with pytest.raises(ValidationError, match="must be a non-negative integer"):
        validate_config(config)


def test_allows_zero_amount_for_set_item(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["per_draw"]["condition"]["actions"] = [
        {"type": "set_item", "id": "general_fragment", "amount": 0}
    ]

    validate_config(config)


def test_rejects_negative_amount_for_set_item(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["stages"]["per_draw"]["condition"]["actions"] = [
        {"type": "set_item", "id": "general_fragment", "amount": -1}
    ]

    with pytest.raises(ValidationError, match="must be a non-negative integer"):
        validate_config(config)


def test_requires_pool_probabilities_to_sum_to_one(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["probability"] = 0.02

    with pytest.raises(ValidationError, match="probability sum must be 1"):
        validate_config(config)


def test_allows_null_pool_entry_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"] = None

    validate_config(config)


def test_rejects_empty_pool_entry_actions(test_config: dict) -> None:
    config = deepcopy(test_config)
    config["pools"]["begin_pool"]["entries"][0]["actions"] = []

    with pytest.raises(ValidationError, match="must be null or a non-empty array"):
        validate_config(config)


def test_requires_non_empty_logic_conditions(test_termination: dict, test_config: dict) -> None:
    termination = deepcopy(test_termination)
    termination["termination_condition"]["conditions"] = []

    with pytest.raises(ValidationError, match="must be non-empty"):
        validate_termination(termination, test_config)
