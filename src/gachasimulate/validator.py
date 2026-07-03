from __future__ import annotations

import math
import re
from typing import Any, NoReturn


class ValidationError(ValueError):
    pass


_IDENTIFIER_PATTERN = r"[A-Za-z_][A-Za-z0-9_]*"
_IDENTIFIER_RE = re.compile(rf"^{_IDENTIFIER_PATTERN}$")
_ACTION_RE = re.compile(rf"^({_IDENTIFIER_PATTERN})\s*(\+=|-=|=)\s*(\d+)$")
_CONDITION_RE = re.compile(rf"^({_IDENTIFIER_PATTERN})\s*(>=|<=|==|!=|>|<)\s*(\d+)$")
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


def _reject_unknown_keys(mapping: dict[str, Any], path: str, allowed: set[str]) -> None:
    for key in mapping:
        if key not in allowed:
            _fail(path + f".{key}", "unsupported field")


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
    if _IDENTIFIER_RE.fullmatch(value) is None:
        _fail(path, "must match [A-Za-z_][A-Za-z0-9_]*")


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
            if not isinstance(name, str):
                _fail(path + f".{item_id}", "name must be a string")
            if not name:
                _fail(path + f".{item_id}", "name must be non-empty")

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
    if actions is None:
        return []
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


def _validate_item_resolve_actions(
    actions: Any,
    path: str,
    *,
    item_id: str,
    item_ids: set[str],
    pool_ids: set[str],
) -> None:
    if actions is None:
        _fail(path, "must be non-empty")
    normalized_actions = _normalize_actions(actions, path)
    matching_reduce_count = 0
    for index, action in enumerate(normalized_actions):
        action_path = f"{path}[{index}]"
        _validate_action(action, action_path, item_ids=item_ids, pool_ids=pool_ids)

        match = _ACTION_RE.fullmatch(action.strip())
        if match is None:
            continue

        action_item_id, op, _ = match.groups()
        if op != "-=":
            continue
        if action_item_id != item_id:
            _fail(action_path, "reduce action must reduce the resolved item")
        matching_reduce_count += 1

    if matching_reduce_count != 1:
        _fail(path, "must contain exactly one reduce action for the resolved item")


def _validate_condition_node(
    node: Any,
    path: str,
    *,
    item_ids: set[str],
    pool_ids: set[str],
) -> None:
    node = _require_mapping(node, path)
    has_check = "check" in node
    has_logic = "op" in node or "children" in node
    if has_check == has_logic:
        _fail(path, "must contain either check or op/children")

    if "actions" in node:
        _validate_actions(
            node["actions"],
            path + ".actions",
            item_ids=item_ids,
            pool_ids=pool_ids,
            allow_empty=True,
        )

    if has_check:
        _reject_unknown_keys(node, path, {"check", "actions"})
        if not isinstance(node["check"], str):
            _fail(path + ".check", "must be a condition string")
        _validate_condition_string(node["check"], path + ".check", item_ids=item_ids)
        return

    _reject_unknown_keys(node, path, {"op", "children", "actions"})
    op = node.get("op")
    if op not in _LOGIC_OPS:
        _fail(path + ".op", f"unsupported logic op: {op}")
    children = _require_list(node.get("children"), path + ".children")
    if not children:
        _fail(path + ".children", "must be non-empty")
    for index, child in enumerate(children):
        _validate_condition_node(
            child,
            f"{path}.children[{index}]",
            item_ids=item_ids,
            pool_ids=pool_ids,
        )


def _validate_condition_string(condition: str, path: str, *, item_ids: set[str]) -> None:
    match = _CONDITION_RE.fullmatch(condition.strip())
    if match is None:
        _fail(path, f"unsupported condition: {condition}")
    item_id = match.group(1)
    if item_id not in item_ids:
        _fail(path, f"unknown item id: {item_id}")


def _actions_have_any_action(actions: Any) -> bool:
    return bool(_normalize_actions(actions, "actions", allow_empty=True))


def _actions_have_terminate(actions: Any) -> bool:
    return any(
        action.strip().partition(" ")[0] == "terminate"
        for action in _normalize_actions(actions, "actions", allow_empty=True)
    )


def _actions_increment_draw_count(actions: Any) -> bool:
    for action in _normalize_actions(actions, "actions", allow_empty=True):
        match = _ACTION_RE.fullmatch(action.strip())
        if match is None:
            continue
        item_id, op, amount = match.groups()
        if item_id == "draw_count" and op == "+=" and int(amount) > 0:
            return True
    return False


def _condition_has_any_action(node: dict[str, Any]) -> bool:
    if _actions_have_any_action(node.get("actions")):
        return True
    if "check" in node:
        return False
    return any(_condition_has_any_action(child) for child in node["children"])


def _condition_all_paths_have_terminate(node: dict[str, Any]) -> bool:
    if _actions_have_terminate(node.get("actions")):
        return True
    if "check" in node:
        return False
    if node["op"] in {"OR", "||"}:
        return all(_condition_all_paths_have_terminate(child) for child in node["children"])
    return any(_condition_all_paths_have_terminate(child) for child in node["children"])


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
            _reject_unknown_keys(entry, path, {"probability", "weight", "actions"})
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
                probability = _require_positive_number(entry["probability"], path + ".probability")
                total_probability += probability
            else:
                _require_positive_number(entry["weight"], path + ".weight")

            if "actions" in entry:
                _validate_actions(
                    entry["actions"],
                    path + ".actions",
                    item_ids=item_ids,
                    pool_ids=pool_ids,
                    allow_empty=True,
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

    if "every_draw" not in config:
        _fail("config.every_draw", "every_draw must increment draw_count")
    _validate_actions(
        config["every_draw"],
        "config.every_draw",
        item_ids=item_ids,
        pool_ids=pool_ids,
        allow_empty=True,
    )
    if not _actions_increment_draw_count(config["every_draw"]):
        _fail("config.every_draw", "every_draw must increment draw_count")

    item_resolves = config.get("item_resolve", [])
    if "item_resolve" in config:
        item_resolves = _require_list(item_resolves, "config.item_resolve")
    seen_item_resolve_items: set[str] = set()
    for index, resolve in enumerate(item_resolves):
        path = f"config.item_resolve[{index}]"
        resolve = _require_mapping(resolve, path)
        _reject_unknown_keys(resolve, path, {"item", "retain", "actions"})
        item_id = resolve.get("item")
        if not isinstance(item_id, str):
            _fail(path + ".item", "must be an item id")
        if item_id not in item_ids:
            _fail(path + ".item", f"unknown item id: {item_id}")
        if item_id in seen_item_resolve_items:
            _fail(path + ".item", f"duplicate item_resolve item: {item_id}")
        seen_item_resolve_items.add(item_id)
        _require_non_negative_int(resolve.get("retain"), path + ".retain")
        if "actions" not in resolve:
            _fail(path + ".actions", "is required")
        _validate_item_resolve_actions(
            resolve["actions"],
            path + ".actions",
            item_id=item_id,
            item_ids=item_ids,
            pool_ids=pool_ids,
        )

    rules = config.get("rules", [])
    if "rules" in config:
        rules = _require_list(rules, "config.rules")
    seen_rule_ids: set[str] = set()
    for index, rule_entry in enumerate(rules):
        path = f"config.rules[{index}]"
        rule_entry = _require_mapping(rule_entry, path)
        if "name" in rule_entry:
            _fail(path + ".name", "rule id must be the mapping key")
        if len(rule_entry) != 1:
            _fail(path, "must be a single-key mapping")
        rule_id, rule = next(iter(rule_entry.items()))
        if not isinstance(rule_id, str):
            _fail(path, "key must be a string")
        _validate_id(rule_id, path)
        if rule_id in seen_rule_ids:
            _fail(path, f"duplicate rule id: {rule_id}")
        seen_rule_ids.add(rule_id)

        rule = _require_mapping(rule, path + f".{rule_id}")
        _reject_unknown_keys(rule, path + f".{rule_id}", {"mode", "condition"})
        mode = rule.get("mode", "once")
        if mode not in _MODES:
            _fail(path + f".{rule_id}.mode", f"unsupported mode: {mode}")

        if "condition" not in rule:
            _fail(path + f".{rule_id}.condition", "is required")
        _validate_condition_node(
            rule["condition"],
            path + f".{rule_id}.condition",
            item_ids=item_ids,
            pool_ids=pool_ids,
        )
        if not _condition_has_any_action(rule["condition"]):
            _fail(
                path + f".{rule_id}.condition",
                "rule condition must contain at least one action",
            )


def validate_termination(termination: dict[str, Any], config: dict[str, Any]) -> None:
    termination = _require_mapping(termination, "termination")
    config = _require_mapping(config, "config")
    item_ids = _item_ids(config)
    pool_ids = _pool_ids(config)

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
    if "conditions" in rule or "cases" in rule or "reason" in rule:
        _fail("termination.termination_rule", "must use condition tree syntax")
    _reject_unknown_keys(rule, "termination.termination_rule", {"condition"})
    if "condition" not in rule:
        _fail("termination.termination_rule.condition", "is required")
    _validate_condition_node(
        rule["condition"],
        "termination.termination_rule.condition",
        item_ids=item_ids,
        pool_ids=pool_ids,
    )
    if not _condition_all_paths_have_terminate(rule["condition"]):
        _fail(
            "termination.termination_rule.condition",
            "every termination path must contain a terminate action",
        )
