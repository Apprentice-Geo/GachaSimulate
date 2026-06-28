from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from .runtime import (
    AddItem,
    CheckNode,
    DrawPool,
    Item,
    ItemResolve,
    LogicNode,
    Pool,
    PoolChange,
    ReduceItem,
    RuntimeAction,
    RuntimeCondition,
    RuntimeConfigContext,
    RuntimeContext,
    RuntimeOpCode,
    Rule,
    SetItem,
    Termination,
)
from .validator import validate_config, validate_termination


_ACTION_RE = re.compile(r"^([^\s=+\-]+)\s*(\+=|-=|=)\s*(\d+)$")
_CONDITION_RE = re.compile(r"^([^\s<>!=]+)\s*(>=|<=|==|!=|>|<)\s*(\d+)$")
_LOGIC_OPS = {
    "AND": RuntimeOpCode.AND,
    "&&": RuntimeOpCode.AND,
    "OR": RuntimeOpCode.OR,
    "||": RuntimeOpCode.OR,
}
_COMPARE_OPS = {
    "==": RuntimeOpCode.EQ,
    "!=": RuntimeOpCode.NE,
    "<": RuntimeOpCode.LT,
    "<=": RuntimeOpCode.LE,
    ">": RuntimeOpCode.GT,
    ">=": RuntimeOpCode.GE,
}


def load_yaml_file(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    if path.suffix not in {".yaml", ".yml"}:
        raise ValueError(f"{path}: config files must use .yaml or .yml")
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path}: YAML root must be a mapping")
    return data


def build_from_files(config_path: str | Path, termination_path: str | Path) -> RuntimeContext:
    return build_context(load_yaml_file(config_path), load_yaml_file(termination_path))


def build_context(config: dict[str, Any], termination: dict[str, Any]) -> RuntimeContext:
    validate_config(config)
    validate_termination(termination, config)

    context = RuntimeConfigContext()
    _build_items(context, config)
    _build_pool_index(context, config)
    _build_pools(context, config)
    _build_initial(context, config)
    _build_every_draw(context, config)
    _build_item_resolves(context, config)
    _merge_termination_retains(context, termination)
    _build_rules(context, config)

    termination_tree = _build_termination_tree(context, termination["termination_rule"])

    return RuntimeContext(
        initial_actions=context.initial_actions,
        every_draw_actions=context.every_draw_actions,
        item_id_index=context.item_id_index,
        draw_count_index=context.item_id_index["draw_count"],
        item_list=context.item_list,
        item_resolve_list=context.item_resolve_list,
        pool_id_index=context.pool_id_index,
        pool_list=context.pool_list,
        pool_draw_list=context.pool_draw_list,
        rule_id_index=context.rule_id_index,
        rule_list=context.rule_list,
        termination_tree=termination_tree,
    )


def _single_key(entry: dict[str, Any]) -> tuple[str, Any]:
    key, value = next(iter(entry.items()))
    return str(key), value


def _item_entries(items: list[Any]) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for item in items:
        if isinstance(item, str):
            entries.append((item, item))
        else:
            item_id, name = _single_key(item)
            entries.append((item_id, item_id if name is None else str(name)))
    return entries


def _pool_entries(pools: list[Any]) -> list[tuple[str, list[dict[str, Any]]]]:
    return [(_single_key(pool_entry)[0], _single_key(pool_entry)[1]) for pool_entry in pools]


def _normalize_actions(actions: str | list[str] | None) -> list[str]:
    if actions is None:
        return []
    if isinstance(actions, str):
        return [actions]
    return actions


def _build_items(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    for index, (item_id, item_name) in enumerate(_item_entries(config["items"])):
        context.item_id_index[item_id] = index
        context.item_list.append(Item(id=item_id, name=item_name))
        context.item_resolve_list.append(ItemResolve())


def _build_pool_index(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    for index, (pool_id, _) in enumerate(_pool_entries(config["pools"])):
        context.pool_id_index[pool_id] = index


def _build_pools(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    for _, entries in _pool_entries(config["pools"]):
        if "probability" in entries[0]:
            probabilities = [float(entry["probability"]) for entry in entries]
        else:
            weights = [float(entry["weight"]) for entry in entries]
            total_weight = sum(weights)
            probabilities = [weight / total_weight for weight in weights]

        cdf = np.cumsum(np.asarray(probabilities, dtype=np.float64))
        cdf[-1] = 1.0
        context.pool_list.append(
            Pool(
                cdf=cdf,
                actions=[
                    _build_actions(context, entry["actions"])
                    for entry in entries
                ],
            )
        )

    context.pool_draw_list = [
        DrawPool(pool_index=index) for index in range(len(context.pool_list))
    ]


def _build_initial(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    context.initial_actions = _build_actions(context, config.get("initial"))


def _build_every_draw(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    context.every_draw_actions = _build_actions(context, config.get("every_draw"))


def _build_item_resolves(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    for resolve in config.get("item_resolve", []):
        item_index = context.item_id_index[resolve["item"]]
        context.item_resolve_list[item_index] = ItemResolve(
            retain=int(resolve["retain"]),
            actions=_build_actions(context, resolve["actions"]),
        )


def _merge_termination_retains(
    context: RuntimeConfigContext, termination: dict[str, Any]
) -> None:
    for retained in termination["retained_items"]:
        item_id, count = _single_key(retained)
        item_index = context.item_id_index[item_id]
        existing = context.item_resolve_list[item_index]
        context.item_resolve_list[item_index] = ItemResolve(
            retain=max(existing.retain, int(count)),
            actions=existing.actions,
        )


def _build_rules(context: RuntimeConfigContext, config: dict[str, Any]) -> None:
    for index, rule in enumerate(config.get("rules", [])):
        rule_id = str(rule.get("name", f"rule_{index}"))
        mode = rule.get("mode", "once")

        if "cases" in rule:
            condition = LogicNode(
                op=RuntimeOpCode.OR,
                conditions=[
                    _build_condition_tree(
                        context,
                        case["conditions"],
                        _build_actions(context, case["actions"]),
                    )
                    for case in rule["cases"]
                ],
                actions=[],
            )
        else:
            condition = _build_condition_tree(
                context,
                rule["conditions"],
                _build_actions(context, rule["actions"]),
            )

        context.rule_id_index[rule_id] = len(context.rule_list)
        context.rule_list.append(Rule(condition=condition, mode=mode))


def _build_termination_tree(
    context: RuntimeConfigContext, rule: dict[str, Any]
) -> RuntimeCondition:
    if "cases" in rule:
        return LogicNode(
            op=RuntimeOpCode.OR,
            conditions=[
                _build_condition_tree(
                    context,
                    case["conditions"],
                    [Termination(reason=case["reason"])],
                )
                for case in rule["cases"]
            ],
            actions=[],
        )

    return _build_condition_tree(
        context,
        rule["conditions"],
        [Termination(reason=rule["reason"])],
    )


def _build_action(context: RuntimeConfigContext, action: str) -> RuntimeAction:
    action = action.strip()

    match = _ACTION_RE.fullmatch(action)
    if match is not None:
        item_id, op, amount_text = match.groups()
        item_index = context.item_id_index[item_id]
        amount = int(amount_text)
        if op == "+=":
            return AddItem(item_index=item_index, amount=amount)
        if op == "-=":
            return ReduceItem(item_index=item_index, amount=amount)
        return SetItem(item_index=item_index, amount=amount)

    command, _, target = action.partition(" ")
    target = target.strip()
    if command == "draw":
        return DrawPool(pool_index=context.pool_id_index[target])
    if command == "change":
        return PoolChange(pool_index=context.pool_id_index[target])
    if command == "terminate":
        return Termination(reason=target)

    raise ValueError(f"unsupported action: {action}")


def _build_actions(
    context: RuntimeConfigContext, actions: str | list[str] | None
) -> list[RuntimeAction]:
    return [_build_action(context, action) for action in _normalize_actions(actions)]


def _build_condition_tree(
    context: RuntimeConfigContext,
    condition: str | list[Any] | dict[str, Any],
    actions: list[RuntimeAction] | None = None,
) -> RuntimeCondition:
    actions = actions or []

    if isinstance(condition, str):
        match = _CONDITION_RE.fullmatch(condition.strip())
        if match is None:
            raise ValueError(f"unsupported condition: {condition}")
        item_id, op, value = match.groups()
        return CheckNode(
            item_index=context.item_id_index[item_id],
            op=_COMPARE_OPS[op],
            value=int(value),
            actions=actions,
        )

    if isinstance(condition, list):
        return LogicNode(
            op=RuntimeOpCode.AND,
            conditions=[_build_condition_tree(context, child) for child in condition],
            actions=actions,
        )

    op = _LOGIC_OPS[condition["op"]]
    return LogicNode(
        op=op,
        conditions=[
            _build_condition_tree(context, child)
            for child in condition["conditions"]
        ],
        actions=actions,
    )
