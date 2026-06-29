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
                "name": "and_rule",
                "mode": "per_draw",
                "condition": {
                    "op": "AND",
                    "children": [
                        {"check": "token >= 1"},
                        {"check": "target >= 1"},
                    ],
                    "actions": "shard += 1",
                },
            },
            {
                "name": "or_rule",
                "condition": {
                    "op": "OR",
                    "children": [
                        {"check": "token == 0", "actions": "draw bonus"},
                        {"check": "token >= 1", "actions": "change bonus"},
                    ],
                },
            },
        ],
        "item_resolve": [{"item": "target", "retain": 1, "actions": "target -= 1"}],
    }


def _valid_termination() -> dict:
    return {
        "retained_items": [{"target": 2}],
        "termination_rule": {
            "condition": {
                "op": "AND",
                "children": [
                    {"check": "target >= 2"},
                    {"check": "draw_count >= 1"},
                ],
                "actions": "terminate done",
            },
        },
    }


def test_validate_config_accepts_yaml_spec_config() -> None:
    validate_config(_valid_config())


def test_validate_config_accepts_optional_empty_actions() -> None:
    config = _valid_config()
    del config["pools"][0]["main"][0]["actions"]
    config["initial"] = None
    config["every_draw"] = None
    config["rules"][1]["condition"]["children"][0].pop("actions")

    validate_config(config)


def test_validate_termination_accepts_yaml_spec_termination() -> None:
    validate_termination(_valid_termination(), _valid_config())


def test_validate_config_rejects_unknown_item_reference() -> None:
    config = _valid_config()
    config["pools"][0]["main"][0]["actions"] = "missing += 1"

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_config(config)


def test_validate_config_rejects_unknown_pool_reference() -> None:
    config = _valid_config()
    config["rules"][1]["condition"]["children"][0]["actions"] = "draw missing"

    with pytest.raises(ValidationError, match="unknown pool id: missing"):
        validate_config(config)


def test_validate_config_rejects_unknown_condition_item_reference() -> None:
    config = _valid_config()
    config["rules"][0]["condition"]["children"][1]["check"] = "missing >= 1"

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


@pytest.mark.parametrize("name", [None, ""])
def test_validate_config_rejects_empty_item_mapping_names(name: object) -> None:
    config = _valid_config()
    config["items"][1] = {"token": name}

    with pytest.raises(ValidationError, match="name must"):
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
    config["rules"][0]["condition"]["op"] = "XOR"

    with pytest.raises(ValidationError, match="unsupported logic op: XOR"):
        validate_config(config)


def test_validate_config_rejects_old_rule_syntax() -> None:
    config = _valid_config()
    config["rules"][0] = {
        "name": "old",
        "conditions": "token >= 1",
        "actions": "shard += 1",
    }

    with pytest.raises(ValidationError, match="must use condition tree syntax"):
        validate_config(config)


def test_validate_config_rejects_noop_rule() -> None:
    config = _valid_config()
    config["rules"][0]["condition"] = {"check": "token >= 1"}

    with pytest.raises(ValidationError, match="must contain at least one action"):
        validate_config(config)


def test_validate_config_rejects_logic_node_without_children() -> None:
    config = _valid_config()
    config["rules"][0]["condition"] = {
        "op": "AND",
        "actions": "shard += 1",
    }

    with pytest.raises(ValidationError, match="children: must be a list"):
        validate_config(config)


def test_validate_config_rejects_item_resolve_without_actions() -> None:
    config = _valid_config()
    del config["item_resolve"][0]["actions"]

    with pytest.raises(ValidationError, match="actions: is required"):
        validate_config(config)


@pytest.mark.parametrize("actions", [None, []])
def test_validate_config_rejects_item_resolve_empty_actions(actions: object) -> None:
    config = _valid_config()
    config["item_resolve"][0]["actions"] = actions

    with pytest.raises(ValidationError, match="must be non-empty"):
        validate_config(config)


def test_validate_config_rejects_item_resolve_without_reduce_action() -> None:
    config = _valid_config()
    config["item_resolve"][0]["actions"] = "shard += 1"

    with pytest.raises(ValidationError, match="exactly one reduce action"):
        validate_config(config)


def test_validate_config_rejects_item_resolve_with_multiple_matching_reduce_actions() -> None:
    config = _valid_config()
    config["item_resolve"][0]["actions"] = [
        "target -= 1",
        "target -= 1",
        "shard += 1",
    ]

    with pytest.raises(ValidationError, match="exactly one reduce action"):
        validate_config(config)


def test_validate_config_rejects_item_resolve_reducing_other_item() -> None:
    config = _valid_config()
    config["item_resolve"][0]["actions"] = ["token -= 1", "shard += 1"]

    with pytest.raises(ValidationError, match="must reduce the resolved item"):
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
    termination["termination_rule"]["condition"]["children"][0]["check"] = "missing >= 1"

    with pytest.raises(ValidationError, match="unknown item id: missing"):
        validate_termination(termination, _valid_config())


def test_validate_termination_rejects_old_reason_syntax() -> None:
    termination = _valid_termination()
    termination["termination_rule"] = {
        "conditions": "target >= 1",
        "reason": "done",
    }

    with pytest.raises(ValidationError, match="must use condition tree syntax"):
        validate_termination(termination, _valid_config())


def test_validate_termination_rejects_path_without_terminate_action() -> None:
    termination = _valid_termination()
    termination["termination_rule"]["condition"] = {
        "op": "OR",
        "children": [
            {"check": "target >= 1", "actions": "terminate target"},
            {"check": "shard >= 1"},
        ],
    }

    with pytest.raises(ValidationError, match="every termination path"):
        validate_termination(termination, _valid_config())
