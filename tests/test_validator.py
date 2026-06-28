from __future__ import annotations

from copy import deepcopy

import pytest

from gachasimulate.validator import (
    ValidationError,
    validate_config,
    validate_termination,
)


def _valid_config() -> dict:
    return {
        "items": [
            {"draw_count": "抽数"},
            "token",
            "target",
            "shard",
        ],
        "pools": [
            {
                "main": [
                    {"probability": 0.5, "actions": "token += 1"},
                    {"probability": 0.5, "actions": "target += 1"},
                ]
            },
            {"bonus": [{"weight": 1, "actions": "shard += 1"}]},
        ],
        "initial": "change main",
        "every_draw": "draw_count += 1",
        "rules": [
            {
                "name": "implicit_and",
                "mode": "per_draw",
                "conditions": ["token >= 1", "target >= 1"],
                "actions": "shard += 1",
            },
            {
                "name": "case_rule",
                "cases": [
                    {"conditions": "token == 0", "actions": "draw bonus"},
                    {"conditions": "token >= 1", "actions": "change bonus"},
                ],
            },
        ],
        "item_resolve": [
            {"item": "target", "retain": 1, "actions": "target -= 1"}
        ],
    }


def _valid_termination() -> dict:
    return {
        "retained_items": [{"target": 2}],
        "termination_rule": {
            "conditions": {
                "op": "AND",
                "conditions": ["target >= 2", "draw_count >= 1"],
            },
            "reason": "done",
        },
    }


def test_validate_config_accepts_yaml_spec_config() -> None:
    validate_config(_valid_config())


def test_validate_termination_accepts_yaml_spec_termination() -> None:
    validate_termination(_valid_termination(), _valid_config())


def test_validate_config_rejects_unknown_item_reference() -> None:
    config = _valid_config()
    config["pools"][0]["main"][0]["actions"] = "missing += 1"

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_config(config)


def test_validate_config_rejects_unknown_pool_reference() -> None:
    config = _valid_config()
    config["rules"][1]["cases"][0]["actions"] = "draw missing"

    with pytest.raises(ValidationError, match="unknown pool id: missing"):
        validate_config(config)


def test_validate_config_rejects_unknown_condition_item_reference() -> None:
    config = _valid_config()
    config["rules"][0]["conditions"][1] = "missing >= 1"

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_config(config)


def test_validate_config_rejects_mixed_probability_and_weight() -> None:
    config = _valid_config()
    config["pools"][0]["main"][1] = {"weight": 1, "actions": "target += 1"}

    with pytest.raises(ValidationError, match="cannot mix probability and weight"):
        validate_config(config)


def test_validate_config_rejects_invalid_probability_sum() -> None:
    config = _valid_config()
    config["pools"][0]["main"][1]["probability"] = 0.4

    with pytest.raises(ValidationError, match="probability sum must be 1"):
        validate_config(config)


def test_validate_config_rejects_bad_item_name_with_spaces() -> None:
    config = _valid_config()
    config["items"][1] = "bad item"

    with pytest.raises(ValidationError, match="cannot contain spaces"):
        validate_config(config)


def test_validate_config_requires_draw_count() -> None:
    config = _valid_config()
    config["items"] = ["token", "target"]

    with pytest.raises(ValidationError, match="draw_count is required"):
        validate_config(config)


def test_validate_config_rejects_old_dict_action_shape() -> None:
    config = _valid_config()
    config["every_draw"] = [{"type": "add_item", "id": "draw_count"}]

    with pytest.raises(ValidationError, match="must be an action string"):
        validate_config(config)


def test_validate_config_rejects_bad_logic_operator() -> None:
    config = _valid_config()
    config["rules"][0]["conditions"] = {
        "op": "XOR",
        "conditions": ["token >= 1", "target >= 1"],
    }

    with pytest.raises(ValidationError, match="unsupported logic op: XOR"):
        validate_config(config)


def test_validate_termination_requires_retained_items() -> None:
    termination = _valid_termination()
    del termination["retained_items"]

    with pytest.raises(ValidationError, match="termination.retained_items: must be a list"):
        validate_termination(termination, _valid_config())


def test_validate_termination_rejects_unknown_retained_item() -> None:
    termination = _valid_termination()
    termination["retained_items"].append({"missing": 1})

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_termination(termination, _valid_config())


def test_validate_termination_rejects_unknown_condition_item() -> None:
    termination = deepcopy(_valid_termination())
    termination["termination_rule"]["conditions"]["conditions"][0] = "missing >= 1"

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_termination(termination, _valid_config())


def test_validate_termination_requires_reason() -> None:
    termination = _valid_termination()
    termination["termination_rule"]["reason"] = ""

    with pytest.raises(ValidationError, match="reason: must be a non-empty string"):
        validate_termination(termination, _valid_config())
