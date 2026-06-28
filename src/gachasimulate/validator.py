from __future__ import annotations

import math
import re
from typing import Any, NoReturn


class ValidationError(ValueError):
    pass


_ACTION_RE = re.compile(r"^([^\s=+\-]+)\s*(\+=|-=|=)\s*(\d+)$")
_CONDITION_RE = re.compile(r"^([^\s<>!=]+)\s*(>=|<=|==|!=|>|<)\s*(\d+)$")
_LOGIC_OPS = {"AND", "OR", "&&", "||"}
_MODES = {"once", "per_draw", "repeat"}


def _fail(path: str, message: str) -> NoReturn:
    raise ValidationError(f"{path}: {message}")


def _require_mapping(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be a mapping")
    return value


def _require_list(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(path, "must be a list")
    return value


def _require_single_key_mapping(value: Any, path: str) -> tuple[str, Any]:
    mapping = _require_mapping(value, path)
    if len(mapping) != 1:
        _fail(path, "must be a single-key mapping")
    key, item = next(iter(mapping.items()))
    if not isinstance(key, str) or not key:
        _fail(path, "key must be a non-empty string")
    return key, item


def _require_non_negative_int(value: Any, path: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        _fail(path, "must be a non-negative integer")
    return value


def _require_positive_number(value: Any, path: str) -> float:
    number = _require_number(value, path)
    if number <= 0:
        _fail(path, "must be positive")
    return number


def _require_number(value: Any, path: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        _fail(path, "must be a number")
    return float(value)


def _validate_id(value: str, path: str) -> None:
    if not value:
        _fail(path, "must be non-empty")
    if any(ch.isspace() for ch in value):
        _fail(path, "cannot contain spaces")


def _item_ids(config: dict[str, Any]) -> set[str]:
    return {item_id for item_id, _ in _parse_items(config.get("items"))}


def _pool_ids(config: dict[str, Any]) -> set[str]:
    return {pool_id for pool_id, _ in _parse_pools(config.get("pools"))}


def _parse_items(items: Any) -> list[tuple[str, Any]]:
    items = _require_list(items, "config.items")
    if not items:
        _fail("config.items", "must be non-empty")

    result: list[tuple[str, Any]] = []
    seen: set[str] = set()
    for index, item in enumerate(items):
        path = f"config.items[{index}]"
        if isinstance(item, str):
            item_id, name = item, item
        else:
            item_id, name = _require_single_key_mapping(item, path)
            if name is not None and not isinstance(name, str):
                _fail(path + f".{item_id}", "name must be a string")

        _validate_id(item_id, path)
        if item_id in seen:
            _fail(path, f"duplicate item id: {item_id}")
        seen.add(item_id)
        result.append((item_id, name))

    return result


def _parse_pools(pools: Any) -> list[tuple[str, Any]]:
    pools = _require_list(pools, "config.pools")
    if not pools:
        _fail("config.pools", "must be non-empty")

    result: list[tuple[str, Any]] = []
    seen: set[str] = set()
    for index, pool in enumerate(pools):
        path = f"config.pools[{index}]"
        pool_id, entries = _require_single_key_mapping(pool, path)
        _validate_id(pool_id, path)
        if pool_id in seen:
            _fail(path, f"duplicate pool id: {pool_id}")
        seen.add(pool_id)
        result.append((pool_id, entries))
    return result


def _normalize_actions(actions: Any, path: str, *, allow_empty: bool = False) -> list[str]:
    if isinstance(actions, str):
        return [actions]
    actions = _require_list(actions, path)
    if not actions and not allow_empty:
        _fail(path, "must be non-empty")
    for index, action in enumerate(actions):
        if not isinstance(action, str):
            _fail(f"{path}[{index}]", "must be an action string")
    return actions


def _validate_actions(
    actions: Any,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
    allow_empty: bool = False,
) -> None:
    for index, action in enumerate(_normalize_actions(actions, path, allow_empty=allow_empty)):
        _validate_action(
            action,
            f"{path}[{index}]",
            item_ids=item_ids,
            pool_ids=pool_ids,
        )


def _validate_action(
    action: str,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
) -> None:
    action = action.strip()
    match = _ACTION_RE.fullmatch(action)
    if match is not None:
        item_id, op, amount = match.groups()
        if item_id not in item_ids:
            _fail(path, f"unknown item id: {item_id}")
        if op != "=" and int(amount) <= 0:
            _fail(path, "amount must be positive")
        return

    command, separator, target = action.partition(" ")
    target = target.strip()
    if command in {"draw", "change"}:
        if not separator or not target:
            _fail(path, f"{command} action requires a pool id")
        if target not in pool_ids:
            _fail(path, f"unknown pool id: {target}")
        return

    if command == "terminate":
        if not separator or not target:
            _fail(path, "terminate action requires a reason")
        return

    _fail(path, f"unsupported action: {action}")


def _validate_condition(
    condition: Any,
    path: str,
    *,
    item_ids: set[str],
) -> None:
    if isinstance(condition, str):
        match = _CONDITION_RE.fullmatch(condition.strip())
        if match is None:
            _fail(path, f"unsupported condition: {condition}")
        item_id = match.group(1)
        if item_id not in item_ids:
            _fail(path, f"unknown item id: {item_id}")
        return

    if isinstance(condition, list):
        if len(condition) < 2:
            _fail(path, "implicit AND requires at least two conditions")
        for index, child in enumerate(condition):
            _validate_condition(child, f"{path}[{index}]", item_ids=item_ids)
        return

    condition = _require_mapping(condition, path)
    op = condition.get("op")
    if op not in _LOGIC_OPS:
        _fail(path + ".op", f"unsupported logic op: {op}")
    children = _require_list(condition.get("conditions"), path + ".conditions")
    if not children:
        _fail(path + ".conditions", "must be non-empty")
    for index, child in enumerate(children):
        _validate_condition(child, f"{path}.conditions[{index}]", item_ids=item_ids)


def validate_config(config: dict[str, Any]) -> None:
    config = _require_mapping(config, "config")

    items = _parse_items(config.get("items"))
    item_ids = {item_id for item_id, _ in items}
    if "draw_count" not in item_ids:
        _fail("config.items", "draw_count is required")

    pools = _parse_pools(config.get("pools"))
    pool_ids = {pool_id for pool_id, _ in pools}

    for pool_index, (pool_id, entries) in enumerate(pools):
        entries = _require_list(entries, f"config.pools[{pool_index}].{pool_id}")
        if not entries:
            _fail(f"config.pools[{pool_index}].{pool_id}", "must be non-empty")

        mode: str | None = None
        total_probability = 0.0
        for entry_index, entry in enumerate(entries):
            path = f"config.pools[{pool_index}].{pool_id}[{entry_index}]"
            entry = _require_mapping(entry, path)
            has_probability = "probability" in entry
            has_weight = "weight" in entry
            if has_probability == has_weight:
                _fail(path, "must contain exactly one of probability or weight")

            entry_mode = "probability" if has_probability else "weight"
            if mode is None:
                mode = entry_mode
            elif mode != entry_mode:
                _fail(f"config.pools[{pool_index}].{pool_id}", "cannot mix probability and weight")

            if has_probability:
                probability = _require_number(entry["probability"], path + ".probability")
                if probability < 0:
                    _fail(path + ".probability", "must be non-negative")
                total_probability += probability
            else:
                _require_positive_number(entry["weight"], path + ".weight")

            if "actions" not in entry:
                _fail(path + ".actions", "is required")
            _validate_actions(
                entry["actions"],
                path + ".actions",
                item_ids=item_ids,
                pool_ids=pool_ids,
            )

        if mode == "probability" and not math.isclose(
            total_probability, 1.0, rel_tol=1e-9, abs_tol=1e-9
        ):
            _fail(
                f"config.pools[{pool_index}].{pool_id}",
                f"probability sum must be 1, got {total_probability}",
            )

    if "initial" in config:
        _validate_actions(
            config["initial"],
            "config.initial",
            item_ids=item_ids,
            pool_ids=pool_ids,
            allow_empty=True,
        )

    if "every_draw" in config:
        _validate_actions(
            config["every_draw"],
            "config.every_draw",
            item_ids=item_ids,
            pool_ids=pool_ids,
            allow_empty=True,
        )

    item_resolves = config.get("item_resolve", [])
    if "item_resolve" in config:
        item_resolves = _require_list(item_resolves, "config.item_resolve")
    for index, resolve in enumerate(item_resolves):
        path = f"config.item_resolve[{index}]"
        resolve = _require_mapping(resolve, path)
        item_id = resolve.get("item")
        if not isinstance(item_id, str):
            _fail(path + ".item", "must be an item id")
        if item_id not in item_ids:
            _fail(path + ".item", f"unknown item id: {item_id}")
        _require_non_negative_int(resolve.get("retain"), path + ".retain")
        if "actions" not in resolve:
            _fail(path + ".actions", "is required")
        _validate_actions(
            resolve["actions"],
            path + ".actions",
            item_ids=item_ids,
            pool_ids=pool_ids,
        )

    rules = config.get("rules", [])
    if "rules" in config:
        rules = _require_list(rules, "config.rules")
    for index, rule in enumerate(rules):
        path = f"config.rules[{index}]"
        rule = _require_mapping(rule, path)
        mode = rule.get("mode", "once")
        if mode not in _MODES:
            _fail(path + ".mode", f"unsupported mode: {mode}")

        has_cases = "cases" in rule
        has_condition_actions = "conditions" in rule or "actions" in rule
        if has_cases == has_condition_actions:
            _fail(path, "must contain either cases or conditions/actions")

        if has_cases:
            cases = _require_list(rule["cases"], path + ".cases")
            if len(cases) < 2:
                _fail(path + ".cases", "must contain at least two cases")
            for case_index, case in enumerate(cases):
                case_path = f"{path}.cases[{case_index}]"
                case = _require_mapping(case, case_path)
                if "conditions" not in case:
                    _fail(case_path + ".conditions", "is required")
                if "actions" not in case:
                    _fail(case_path + ".actions", "is required")
                _validate_condition(
                    case["conditions"],
                    case_path + ".conditions",
                    item_ids=item_ids,
                )
                _validate_actions(
                    case["actions"],
                    case_path + ".actions",
                    item_ids=item_ids,
                    pool_ids=pool_ids,
                )
            continue

        if "conditions" not in rule:
            _fail(path + ".conditions", "is required")
        if "actions" not in rule:
            _fail(path + ".actions", "is required")
        _validate_condition(rule["conditions"], path + ".conditions", item_ids=item_ids)
        _validate_actions(
            rule["actions"],
            path + ".actions",
            item_ids=item_ids,
            pool_ids=pool_ids,
        )


def validate_termination(termination: dict[str, Any], config: dict[str, Any]) -> None:
    termination = _require_mapping(termination, "termination")
    config = _require_mapping(config, "config")
    item_ids = _item_ids(config)

    retained_items = _require_list(
        termination.get("retained_items"),
        "termination.retained_items",
    )
    for index, retained in enumerate(retained_items):
        item_id, count = _require_single_key_mapping(
            retained,
            f"termination.retained_items[{index}]",
        )
        if item_id not in item_ids:
            _fail(f"termination.retained_items[{index}]", f"unknown item id: {item_id}")
        _require_non_negative_int(count, f"termination.retained_items[{index}].{item_id}")

    rule = _require_mapping(
        termination.get("termination_rule"),
        "termination.termination_rule",
    )
    if "conditions" not in rule:
        _fail("termination.termination_rule.conditions", "is required")
    _validate_condition(
        rule["conditions"],
        "termination.termination_rule.conditions",
        item_ids=item_ids,
    )
    if not isinstance(rule.get("reason"), str) or not rule["reason"]:
        _fail("termination.termination_rule.reason", "must be a non-empty string")
