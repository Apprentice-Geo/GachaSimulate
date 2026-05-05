from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


class ValidationError(ValueError):
    pass


ACTION_TYPES = {
    "add_item",
    "reduce_item",
    "set_item",
    "draw_pool",
    "pool_change",
    "termination",
}
PREDICATE_SUBJECTS = {"item", "draw_count"}
PREDICATE_OPS = {">=", ">", "==", "<=", "<", "!="}
LOGIC_OPS = {"AND", "OR"}


def _fail(path: str, message: str) -> None:
    raise ValidationError(f"{path}: {message}")


def _require_mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    return value


def _require_list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(path, "must be an array")
    return value


def _require_positive_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        _fail(path, "must be a positive integer")
    return value


def _require_non_negative_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        _fail(path, "must be a non-negative integer")
    return value


def _require_number(value: Any, path: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        _fail(path, "must be a number")
    return float(value)


def _validate_action(
    action: Any,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
    termination_only: bool,
) -> None:
    action = _require_mapping(action, path)

    action_type = action.get("type")
    if action_type not in ACTION_TYPES:
        _fail(path + ".type", f"unsupported action type: {action_type}")

    if termination_only and action_type != "termination":
        _fail(path + ".type", "termination tree actions must use type 'termination'")

    if "amount" in action:
        if action_type == "set_item":
            _require_non_negative_int(action["amount"], path + ".amount")
        else:
            _require_positive_int(action["amount"], path + ".amount")

    if action_type in {"add_item", "reduce_item", "set_item"}:
        item_id = action.get("id")
        if not isinstance(item_id, str):
            _fail(path + ".id", "must be a string item id")
        if item_id not in item_ids:
            _fail(path + ".id", f"unknown item id: {item_id}")
        return

    if action_type in {"draw_pool", "pool_change"}:
        pool_id = action.get("id")
        if not isinstance(pool_id, str):
            _fail(path + ".id", "must be a string pool id")
        if pool_id not in pool_ids:
            _fail(path + ".id", f"unknown pool id: {pool_id}")
        return

    if action_type == "termination" and "reason" in action:
        if not isinstance(action["reason"], str):
            _fail(path + ".reason", "must be a string")


def _validate_actions(
    actions: Any,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
    termination_only: bool,
    allow_empty: bool = True,
) -> None:
    actions = _require_list(actions, path)
    if not allow_empty and not actions:
        _fail(path, "must be null or a non-empty array")
    for index, action in enumerate(actions):
        _validate_action(
            action,
            f"{path}[{index}]",
            item_ids=item_ids,
            pool_ids=pool_ids,
            termination_only=termination_only,
        )


def _validate_condition(
    condition: Any,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
    termination_only: bool,
) -> None:
    condition = _require_mapping(condition, path)
    condition_type = condition.get("type")

    actions = condition.get("actions")
    if actions is not None:
        _validate_actions(
            actions,
            path + ".actions",
            item_ids=item_ids,
            pool_ids=pool_ids,
            termination_only=termination_only,
        )

    if condition_type == "predicate":
        subject = condition.get("subject")
        if subject not in PREDICATE_SUBJECTS:
            _fail(path + ".subject", f"unsupported predicate subject: {subject}")

        op = condition.get("op")
        if op not in PREDICATE_OPS:
            _fail(path + ".op", f"unsupported predicate op: {op}")

        if "value" not in condition:
            _fail(path + ".value", "is required")
        if not isinstance(condition["value"], int) or isinstance(condition["value"], bool):
            _fail(path + ".value", "must be an integer")

        if "id" not in condition:
            _fail(path + ".id", "must be present")
        subject_id = condition["id"]

        if subject == "item":
            if not isinstance(subject_id, str):
                _fail(path + ".id", "must be a string item id")
            if subject_id not in item_ids:
                _fail(path + ".id", f"unknown item id: {subject_id}")
        else:
            if subject_id is not None:
                _fail(path + ".id", "must be null when subject is not 'item'")
        return

    if condition_type == "logic":
        op = condition.get("op")
        if op not in LOGIC_OPS:
            _fail(path + ".op", f"unsupported logic op: {op}")

        if "conditions" not in condition:
            _fail(path + ".conditions", "is required")
        conditions = _require_list(condition["conditions"], path + ".conditions")
        if not conditions:
            _fail(path + ".conditions", "must be non-empty")

        for index, child in enumerate(conditions):
            _validate_condition(
                child,
                f"{path}.conditions[{index}]",
                item_ids=item_ids,
                pool_ids=pool_ids,
                termination_only=termination_only,
            )
        return

    _fail(path + ".type", f"unsupported condition type: {condition_type}")


def validate_config(config: dict[str, Any]) -> None:
    config = _require_mapping(config, "config")

    items = _require_mapping(config.get("items"), "config.items")
    item_ids = set(items.keys())

    pools = _require_mapping(config.get("pools"), "config.pools")
    if not pools:
        _fail("config.pools", "must be non-empty")
    if next(iter(pools)) != "begin_pool":
        _fail("config.pools", "first pool must be named 'begin_pool'")
    pool_ids = set(pools.keys())

    item_draw = config.get("item_draw", {})
    item_draw = _require_mapping(item_draw, "config.item_draw")
    for item_id, actions in item_draw.items():
        if item_id not in item_ids:
            _fail(f"config.item_draw.{item_id}", f"unknown item id: {item_id}")
        _validate_actions(
            actions,
            f"config.item_draw.{item_id}",
            item_ids=item_ids,
            pool_ids=pool_ids,
            termination_only=False,
        )

    item_resolve = config.get("item_resolve", {})
    item_resolve = _require_mapping(item_resolve, "config.item_resolve")
    for item_id, resolve_config in item_resolve.items():
        if item_id not in item_ids:
            _fail(f"config.item_resolve.{item_id}", f"unknown item id: {item_id}")
        resolve_config = _require_mapping(
            resolve_config,
            f"config.item_resolve.{item_id}",
        )
        if "retain" not in resolve_config:
            _fail(f"config.item_resolve.{item_id}.retain", "is required")
        _require_non_negative_int(
            resolve_config["retain"],
            f"config.item_resolve.{item_id}.retain",
        )
        if "actions" not in resolve_config:
            _fail(f"config.item_resolve.{item_id}.actions", "is required")
        _validate_actions(
            resolve_config["actions"],
            f"config.item_resolve.{item_id}.actions",
            item_ids=item_ids,
            pool_ids=pool_ids,
            termination_only=False,
        )

    for pool_id, pool_config in pools.items():
        pool_config = _require_mapping(pool_config, f"config.pools.{pool_id}")
        entries = _require_list(pool_config.get("entries"), f"config.pools.{pool_id}.entries")
        if not entries:
            _fail(f"config.pools.{pool_id}.entries", "must be non-empty")

        total_probability = 0.0
        for index, entry in enumerate(entries):
            entry = _require_mapping(entry, f"config.pools.{pool_id}.entries[{index}]")
            probability = _require_number(
                entry.get("probability"),
                f"config.pools.{pool_id}.entries[{index}].probability",
            )
            if probability < 0:
                _fail(
                    f"config.pools.{pool_id}.entries[{index}].probability",
                    "must be non-negative",
                )
            total_probability += probability
            if "actions" not in entry:
                _fail(f"config.pools.{pool_id}.entries[{index}].actions", "is required")
            actions = entry["actions"]
            if actions is not None:
                _validate_actions(
                    actions,
                    f"config.pools.{pool_id}.entries[{index}].actions",
                    item_ids=item_ids,
                    pool_ids=pool_ids,
                    termination_only=False,
                    allow_empty=False,
                )

        if not math.isclose(total_probability, 1.0, rel_tol=1e-9, abs_tol=1e-9):
            _fail(
                f"config.pools.{pool_id}.entries",
                f"probability sum must be 1, got {total_probability}",
            )

    stages = config.get("stages", {})
    stages = _require_mapping(stages, "config.stages")
    for stage_id, stage_config in stages.items():
        stage_config = _require_mapping(stage_config, f"config.stages.{stage_id}")
        if "once" in stage_config and not isinstance(stage_config["once"], bool):
            _fail(f"config.stages.{stage_id}.once", "must be a boolean")
        _validate_condition(
            stage_config.get("condition"),
            f"config.stages.{stage_id}.condition",
            item_ids=item_ids,
            pool_ids=pool_ids,
            termination_only=False,
        )


def validate_termination(
    termination: dict[str, Any], config: dict[str, Any]
) -> None:
    termination = _require_mapping(termination, "termination")
    config = _require_mapping(config, "config")
    item_ids = set(_require_mapping(config.get("items"), "config.items").keys())
    pool_ids = set(_require_mapping(config.get("pools"), "config.pools").keys())

    retained_items = termination.get("retained_items", [])
    retained_items = _require_list(retained_items, "termination.retained_items")
    for index, item_id in enumerate(retained_items):
        if not isinstance(item_id, str):
            _fail(f"termination.retained_items[{index}]", "must be a string item id")
        if item_id not in item_ids:
            _fail(
                f"termination.retained_items[{index}]",
                f"unknown item id: {item_id}",
            )

    _validate_condition(
        termination.get("termination_condition"),
        "termination.termination_condition",
        item_ids=item_ids,
        pool_ids=pool_ids,
        termination_only=True,
    )


def validate_files(config_path: str, termination_path: str) -> None:
    config = json.loads(Path(config_path).read_text(encoding="utf-8"))
    termination = json.loads(Path(termination_path).read_text(encoding="utf-8"))
    validate_config(config)
    validate_termination(termination, config)
