from __future__ import annotations

import json
from typing import Any, List, Dict, Optional, Tuple
import numpy as np

from .validator import validate_config, validate_files, validate_termination
from .runtime import (
    RuntimeOpCode,
    RuntimeAction,
    RuntimeConfigContext,
    RuntimeContext,
    RuntimeCondition,
    CheckNode,
    LogicNode,
    AddItem,
    ReduceItem,
    SetItem,
    DrawPool,
    PoolChange,
    Termination,
    Item,
    ItemResolve,
    Pool,
    Stage,
    Reporter,
)


class RuntimeBuilder:
    def __init__(
            self,
            config_path: str,
            termination_path: str,
            config_schema_path: str,
            termination_schema_path: str,
    ):
        validate_files(config_path, termination_path, config_schema_path, termination_schema_path)
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        with open(termination_path, "r", encoding="utf-8") as f:
            self.termination_config = json.load(f)
        self._init_runtime_storage()

    @classmethod
    def from_config(
            cls, config: dict[str, Any], termination_config: dict[str, Any]
    ) -> "RuntimeBuilder":
        validate_config(config)
        validate_termination(termination_config, config)
        builder = cls.__new__(cls)
        builder.config = config
        builder.termination_config = termination_config
        builder._init_runtime_storage()
        return builder

    def _init_runtime_storage(self):
        self.item_id_index = {}
        self.item_list = []
        self.item_resolve_index = []
        self.item_resolve_list = []
        self.item_draw_list = []
        self.pool_id_index = {}
        self.pool_list = []
        self.pool_draw_list = []
        self.draw_stage_id_index = {}
        self.draw_stage_list = []
        self.retained_items_index = []
        self.begin_pool_index = 0
        self.draw_count_index = 0
        self.initial_actions = []
        self.every_draw_actions = []
        self.termination_tree = None
        self.OP_TO_CODE: dict[str, RuntimeOpCode] = {
            "==": RuntimeOpCode.EQ,
            "!=": RuntimeOpCode.NE,
            "<": RuntimeOpCode.LT,
            "<=": RuntimeOpCode.LE,
            ">": RuntimeOpCode.GT,
            ">=": RuntimeOpCode.GE,
            "AND": RuntimeOpCode.AND,
            "OR": RuntimeOpCode.OR,
            "NOT": RuntimeOpCode.NOT,
        }

    def _resolve_item_index(self, item_id: str) -> int:
        return self.item_id_index[item_id]

    def _resolve_pool_index(self, pool_id: str) -> int:
        return self.pool_id_index[pool_id]

    def _build_action(self, action_config: dict[str, Any]) -> RuntimeAction:
        action_type = action_config.get("type")

        if action_type == "add_item":
            item_id = action_config["id"]
            return AddItem(
                item_index=self._resolve_item_index(item_id),
                amount=int(action_config.get("amount", 1)),
            )
        elif action_type == "reduce_item":
            item_id = action_config["id"]
            return ReduceItem(
                item_index=self._resolve_item_index(item_id),
                amount=int(action_config.get("amount", 1)),
            )
        elif action_type == "set_item":
            item_id = action_config["id"]
            return SetItem(
                item_index=self._resolve_item_index(item_id),
                amount=int(action_config.get("amount", 0)),
            )
        elif action_type == "draw_pool":
            pool_id = action_config["id"]
            return DrawPool(
                pool_index=self._resolve_pool_index(pool_id),
            )
        elif action_type == "pool_change":
            pool_id = action_config["id"]
            return PoolChange(
                pool_index=self._resolve_pool_index(pool_id),
            )
        elif action_type == "termination":
            return Termination(
                reason=str(action_config.get("reason", "")),
            )
        else:
            raise ValueError(f"unsupported action type: {action_type}")

    def _build_actions(self, action_configs: list[dict[str, Any]] | None) -> list[RuntimeAction]:
        actions: list[RuntimeAction] = []
        for action_config in action_configs or []:
            actions.append(self._build_action(action_config))
        return actions

    def _build_items(self):
        self.item_id_index.clear()
        self.item_list.clear()
        self.item_resolve_list.clear()
        self.item_draw_list.clear()

        for index, (item_id, item_config) in enumerate(self.config.get("items", {}).items()):
            self.item_id_index[item_id] = index
            self.item_list.append(
                Item(
                    id=item_id,
                    name=item_config.get("name", ""),
                )
            )
            self.item_resolve_list.append(ItemResolve(retain=0, actions=[]))
            self.item_draw_list.append([])

        self.draw_count_index = self._resolve_item_index("draw_count")

    def _build_item_resolves(self):
        for item_id, item_config in self.config.get("items", {}).items():
            resolve_config = item_config.get("resolve")
            if resolve_config is None:
                continue
            item_index = self._resolve_item_index(item_id)
            self.item_resolve_list[item_index] = ItemResolve(
                retain=int(resolve_config["retain"]),
                actions=self._build_actions(resolve_config["actions"]),
            )

    def _build_item_draws(self):
        for item_id, item_config in self.config.get("items", {}).items():
            actions_config = item_config.get("on_acquire")
            if actions_config is None:
                continue
            item_index = self._resolve_item_index(item_id)
            self.item_draw_list[item_index] = self._build_actions(actions_config)

    def _build_pools(self):
        self.pool_id_index.clear()
        self.pool_list.clear()

        pool_sources: list[tuple[str, dict[str, Any]]] = []

        for pool_id, pool_config in self.config.get("pools", {}).items():
            pool_sources.append((pool_id, pool_config))

        for index, (pool_id, _) in enumerate(pool_sources):
            self.pool_id_index[pool_id] = index

        for pool_id, pool_config in pool_sources:
            entries = pool_config.get("entries", [])
            actions: list[list[RuntimeAction]] = []
            probabilities: list[float] = []

            for entry in entries:
                probabilities.append(float(entry.get("probability", 0.0)))
                actions.append(self._build_actions(entry.get("actions", [])))

            cdf = np.cumsum(np.asarray(probabilities, dtype=np.float64))
            if cdf.size:
                cdf[-1] = 1.0

            self.pool_list.append(Pool(cdf=cdf, actions=actions))

    def _build_initial(self):
        initial_config = self.config["initial"]
        self.begin_pool_index = self._resolve_pool_index(initial_config["begin_pool"])
        self.initial_actions = self._build_actions(initial_config.get("actions"))

    def _build_every_draw(self):
        self.every_draw_actions = self._build_actions(self.config["every_draw"])

    def _build_pool_draw_list(self):
        self.pool_draw_list.clear()
        for pool_index in range(len(self.pool_list)):
            self.pool_draw_list.append(DrawPool(pool_index=pool_index))

    def _build_stages(self):
        self.draw_stage_id_index.clear()
        self.draw_stage_list.clear()

        stage_sources = self.config.get("stages", {})

        for stage_id, stage_config in stage_sources.items():
            condition_config = stage_config["condition"]
            condition = self._build_condition_tree(condition_config)
            if condition is None:
                raise ValueError("stage condition cannot be None")
            stage_once = bool(stage_config.get("once", False))

            self.draw_stage_id_index[stage_id] = len(self.draw_stage_list)
            self.draw_stage_list.append(
                Stage(
                    once=stage_once,
                    condition=condition,
                )
            )

    def _build_condition_tree(
            self, condition_config: dict[str, Any] | None
    ) -> RuntimeCondition | None:
        if condition_config is None:
            return None

        condition_type = condition_config.get("type")
        actions_config = condition_config.get("actions")
        actions = self._build_actions(actions_config) if actions_config is not None else []

        if condition_type == "logic":
            conditions: list[RuntimeCondition] = []
            for child in condition_config.get("conditions", []):
                child_condition = self._build_condition_tree(child)
                if child_condition is None:
                    raise ValueError("logic condition child cannot be None")
                conditions.append(child_condition)
            return LogicNode(
                op=self.OP_TO_CODE[condition_config["op"]],
                conditions=conditions,
                actions=actions,
            )

        if condition_type == "predicate":
            return CheckNode(
                item_index=self._resolve_item_index(condition_config["id"]),
                op=self.OP_TO_CODE[condition_config["op"]],
                value=int(condition_config.get("value", 0)),
                actions=actions,
            )

        raise ValueError(f"unsupported condition type: {condition_type}")

    def build(self):
        self._build_items()
        self._build_pools()
        self._build_initial()
        self._build_every_draw()
        self._build_pool_draw_list()
        self._build_item_draws()
        self._build_item_resolves()
        self._build_stages()
        self.termination_tree = self._build_condition_tree(
            self.termination_config["termination_condition"]
        )
        if self.termination_tree is None:
            raise ValueError("termination condition cannot be None")
        self.retained_items_index = [
            self._resolve_item_index(item_id)
            for item_id in self.termination_config.get("retained_items", [])
        ]

        return RuntimeContext(
            begin_pool_index=self.begin_pool_index,
            initial_actions=self.initial_actions,
            every_draw_actions=self.every_draw_actions,
            item_id_index=self.item_id_index,
            draw_count_index=self.draw_count_index,
            item_list=self.item_list,
            item_resolve_list=self.item_resolve_list,
            item_draw_list=self.item_draw_list,
            pool_id_index=self.pool_id_index,
            pool_list=self.pool_list,
            pool_draw_list=self.pool_draw_list,
            draw_stage_id_index=self.draw_stage_id_index,
            draw_stage_list=self.draw_stage_list,
            retained_items_index=self.retained_items_index,
            termination_tree=self.termination_tree,
        )


def _analyse_action(
        context: RuntimeContext | RuntimeConfigContext,
        action: str | Dict[str, Any],
        reporter: Optional[Reporter] = None,
        report_level: Reporter.ReportLevel = Reporter.ReportLevel.Error
) -> Optional[RuntimeAction]:
    match action:
        case "termination":
            return Termination(reason="")
        case str():
            i = 0
            action = action.strip()
            while i < len(action) and not action[i].isspace() and action[i] not in ("+", "-", "="):
                i += 1
            item_id = action[:i].strip()
            while i < len(action) and action[i].isspace():
                i += 1
            item_idx = context.item_id_index.get(item_id)
            if item_idx is None and item_id not in ("draw", "change", "terminate"):
                if reporter is not None:
                    reporter.log(f"{action}: no item named '{item_id}'", report_level)
                return None
            if action[i:i + 2] == "+=":
                num = action[i + 2:].strip()
                if not num.isdigit():
                    if reporter:
                        reporter.log(f"'{action}': invalid number '{num}'", report_level)
                    return None
                return AddItem(item_index=context.item_id_index[item_id], amount=int(num))
            elif action[i:i + 2] == "++":
                postfix = action[i + 2:].strip()
                if postfix:
                    if reporter:
                        reporter.log(f"{action}: use '{item_id}++' instead", report_level)
                    return None
                return AddItem(item_index=context.item_id_index[item_id], amount=1)
            elif action[i:i + 2] == "-=":
                num = action[i + 2:].strip()
                if not num.isdigit():
                    if reporter:
                        reporter.log(f"'{action}': invalid number '{num}'", report_level)
                    return None
                return ReduceItem(item_index=context.item_id_index[item_id], amount=int(num))
            elif action[i:i + 2] == "--":
                postfix = action[i + 2:].strip()
                if postfix:
                    if reporter:
                        reporter.log(f"{action}: use '{item_id}--' instead", report_level)
                    return None
                return ReduceItem(item_index=context.item_id_index[item_id], amount=1)
            elif action[i:i+1] == "=":
                num = action[i + 1:].strip()
                if not num.isdigit():
                    if reporter:
                        reporter.log(f"'{action}': invalid number '{num}'", report_level)
                    return None
                return SetItem(item_index=context.item_id_index[item_id], amount=int(num))

            match item_id:
                case "draw":
                    pool_id = action[i:].strip()
                    pool_idx = context.pool_id_index.get(pool_id)
                    if pool_idx is None:
                        if reporter:
                            reporter.log(f"'{action}': no pool named '{pool_id}'", report_level)
                        return None
                    return DrawPool(pool_index=pool_idx)
                case "change":
                    pool_id = action[i:].strip()
                    pool_idx = context.pool_id_index.get(pool_id)
                    if pool_idx is None:
                        if reporter:
                            reporter.log(f"'{action}': no pool named '{pool_id}'", report_level)
                        return None
                    return PoolChange(pool_index=pool_idx)
                case "terminate":
                    return Termination(reason=action[i:].strip())

            if reporter:
                reporter.log(f"'{action}': unknown action", report_level)
            return None
        case {"type": "draw_pool", "id": item_id}:
            idx = context.pool_id_index.get(item_id)
            if idx is None:
                if reporter:
                    reporter.log(f"{item_id}: no pool named '{item_id}'", report_level)
                return None
            return DrawPool(pool_index=idx)
        case {"type": "pool_change", "id": item_id}:
            idx = context.pool_id_index.get(item_id)
            if idx is None:
                if reporter:
                    reporter.log(f"{item_id}: no pool named '{item_id}'", report_level)
                return None
            return PoolChange(pool_index=idx)
        case {"type": "termination"}:
            return Termination(reason=action.get("reason", ""))
        case {"type": "add_item", "id": item_id}:
            idx = context.item_id_index.get(item_id)
            if idx is None:
                if reporter:
                    reporter.log(f"{item_id}: no item named '{item_id}'", report_level)
                return None
            return AddItem(item_index=idx, amount=int(action.get("amount", 1)))
        case {"type": "reduce_item", "id": item_id}:
            idx = context.item_id_index.get(item_id)
            if idx is None:
                if reporter:
                    reporter.log(f"{item_id}: no item named '{item_id}'", report_level)
                return None
            return ReduceItem(item_index=idx, amount=int(action.get("amount", 1)))
        case {"type": "set_item", "id": item_id}:
            idx = context.item_id_index.get(item_id)
            if idx is None:
                if reporter:
                    reporter.log(f"{item_id}: no item named '{item_id}'", report_level)
                return None
            return SetItem(item_index=idx, amount=int(action.get("amount", 1)))
        case {"type": "add_item"} | {"type": "reduce_item"} | {"type": "set_item"}:
            if reporter:
                reporter.log(f"{action}: missing parameter 'id'", report_level)
            return None
        case {"type": action_type}:
            if reporter:
                reporter.log(f"{action}: unknown action type '{action_type}'", report_level)
            return None
        case {}:
            if reporter:
                reporter.log(f"{action}: missing parameter 'type'", report_level)
    if reporter:
        reporter.log(f"{action!r}: unknown action", report_level)
    return None


def _analyse_actions(
        context: RuntimeContext | RuntimeConfigContext,
        actions: List[str | Dict[str, Any]],
        reporter: Optional[Reporter] = None,
        report_level: Reporter.ReportLevel = Reporter.ReportLevel.Error
) -> List[RuntimeAction]:
    return [x for x in
            (_analyse_action(context, action, reporter, report_level) for action in actions)
            if x is not None]


def _str2node(s: str) -> Optional[Tuple[str, RuntimeOpCode, str]]:
    i = 0
    s = s.strip()
    while i < len(s) and not s[i].isspace() and s[i] not in ("<", ">", "!", "="):
        i += 1
    item_id = s[:i].strip()
    while i < len(s) and s[i].isspace():
        i += 1
    if s[i:i+2] == "<=":
        return item_id, RuntimeOpCode.LE, s[i+2:].strip()
    elif s[i:i+2] == ">=":
        return item_id, RuntimeOpCode.GE, s[i+2:].strip()
    elif s[i:i+2] == "!=":
        return item_id, RuntimeOpCode.NE, s[i+2:].strip()
    elif s[i:i+2] == "==":
        return item_id, RuntimeOpCode.EQ, s[i+2:].strip()
    elif s[i:i+1] == "<":
        return item_id, RuntimeOpCode.LT, s[i+1:].strip()
    elif s[i:i+1] == ">":
        return item_id, RuntimeOpCode.GT, s[i+1:].strip()
    elif s[i:i+1] == "=":
        return item_id, RuntimeOpCode.EQ, s[i+1:].strip()
    return None


def _build_condition_tree(
        context: RuntimeContext | RuntimeConfigContext,
        condition: Optional[Dict[str, Any] | str] = None,
        reporter: Optional[Reporter] = None,
        report_level: Reporter.ReportLevel = Reporter.ReportLevel.Error
) -> Optional[RuntimeCondition]:
    if condition is None:
        return None

    def conditions2children(c):
        result = []
        has_bad_children = False
        for child in c:
            child_condition = _build_condition_tree(context, child, reporter, report_level)
            if child_condition is None:
                if reporter is not None:
                    reporter.log(f"{child!r}: invalid child condition", report_level)
                has_bad_children = True
                continue
            result.append(child_condition)
        if has_bad_children:
            return None
        return result

    match condition:
        case (
        {"op": "OR", "conditions": conditions}
        |{"op": "or", "conditions": conditions}
        |{"op": "|", "conditions": conditions}
        |{"op": "AND", "conditions": conditions}
        |{"op": "and", "conditions": conditions}
        |{"op": "&", "conditions": conditions}
        ):
            children = conditions2children(conditions)
            actions = _analyse_actions(context, condition.get("actions", []), reporter, report_level)
            if children is None:
                return None
            match condition["op"]:
                case "OR" | "or" | "|":
                    return LogicNode(
                        op=RuntimeOpCode.OR,
                        conditions=children,
                        actions=actions
                    )
                case "AND" | "and" | "&":
                    return LogicNode(
                        op=RuntimeOpCode.AND,
                        conditions=children,
                        actions=actions
                    )
            return None
        case (
        {"op": ">=", "id": item_id, "value": value}
        |{"op": ">", "id": item_id, "value": value}
        |{"op": "<=", "id": item_id, "value": value}
        |{"op": "<", "id": item_id, "value": value}
        |{"op": "==", "id": item_id, "value": value}
        |{"op": "!=", "id": item_id, "value": value}
        ):
            actions = _analyse_actions(context, condition.get("actions", []), reporter, report_level)
            item_idx = context.item_id_index.get(item_id)
            if item_idx is None:
                if reporter is not None:
                    reporter.log(f"{condition!r}: unknown item '{item_id}'", report_level)
                return None
            return CheckNode(
                item_index=item_idx,
                op=RuntimeOpCode(condition["op"]),
                value=int(value),
                actions=actions
            )
        case str():
            # deal with logic node
            if condition[:2].upper() == "OR" or condition[:1] == "|":
                if condition[0] == "|":
                    children_s = condition[1:].split(",")
                else:
                    children_s = condition[2:].split(",")
                children = conditions2children(children_s)
                if children is None:
                    return None
                return LogicNode(
                    op=RuntimeOpCode.OR,
                    conditions=children,
                    actions=[]
                )
            if condition[:3].upper() == "AND" or condition[:1] == "&":
                if condition[0] == "&":
                    children_s = condition[1:].split(",")
                else:
                    children_s = condition[3:].split(",")
                children = conditions2children(children_s)
                if children is None:
                    return None
                return LogicNode(
                    op=RuntimeOpCode.AND,
                    conditions=children,
                    actions=[]
                )

            # check node init
            node_result = _str2node(condition)
            if node_result is None:
                if reporter is not None:
                    reporter.log(f"{condition!r}: unknown condition", report_level)
                return None
            item_idx, op, value = node_result
            item_idx = context.item_id_index.get(item_idx)
            if item_idx is None:
                if reporter is not None:
                    reporter.log(f"{condition!r}: unknown item '{item_idx}'", report_level)
                return None
            try:
                value = int(value)
            except ValueError:
                if reporter is not None:
                    reporter.log(f"{condition!r}: unknown value '{value}'", report_level)
                return None
            return CheckNode(
                item_index=item_idx,
                op=op,
                value=value,
                actions=[]
            )
        case _:
            if reporter is not None:
                reporter.log(f"{condition!r}: unknown condition", report_level)
            return None


def config_builder(config: dict[str, Any]) -> Optional[RuntimeConfigContext]:
    context = RuntimeConfigContext()
    # init items
    reporter = Reporter()

    # ---- build items start ----
    items = config.get("items")
    if items is not None:
        for item_id, item_config in items.items():
            match item_config:
                case str():
                    context.item_list.append(
                        Item(
                            id=item_id,
                            name=item_config
                        )
                    )
                    context.item_resolve_list.append(ItemResolve())
                case {"name": item_name}:
                    context.item_list.append(
                        Item(
                            id=item_id,
                            name=item_name
                        )
                    )

                    resolve = item_config.get("resolve")
                    if resolve:
                        for _ in range(1):
                            retain = resolve.get("retain")
                            if retain is None:
                                reporter.error(f"{resolve!r}: missing parameter 'retain'")
                                context.item_resolve_list.append(ItemResolve())
                                break
                            try:
                                retain = int(retain)
                            except ValueError:
                                reporter.error(f"{retain!r}: invalid retain value")
                                context.item_resolve_list.append(ItemResolve())
                                break
                            context.item_resolve_list.append(
                                ItemResolve(
                                    retain=retain,
                                    actions=[]
                                )
                            )
                    else:
                        context.item_resolve_list.append(ItemResolve())
                case _:
                    reporter.error(f"Invalid item config: {item_config!r}")
                    continue
            context.item_id_index[item_id] = len(context.item_list) - 1
            context.item_draw_list.append([])
    else:
        reporter.error("missing item config 'items'")
        # help linter learn items MUST NOT be None
        reporter.report()
        return None
    # ---- build items end ----

    # ---- build pools start ----
    pools = config.get("pools")
    if pools is not None:
        # check prob and decide how to calculate cdf
        for pool_id, pool_config in pools.items():
            entities = None
            match pool_config:
                case list() as entries_p:
                    entities = entries_p
                case {"entries": entries_p} | {"entities": entries_p}:
                    entities = entries_p
                case _:
                    reporter.error(f"Pool '{pool_id}: invalid pool config {pool_config!r}")
                    continue

            probabilities = list(map(lambda entry: entry.get("probability", 0), entities))
            has_invalid_num = False
            for i in range(len(probabilities)):
                value = probabilities[i]
                match value:
                    case str():
                        frac = value.split("/", 2)
                        if len(frac) == 1:
                            try:
                                probabilities[i] = float(frac[0])
                            except ValueError:
                                reporter.error(f"Pool '{pool_id}': invalid probability {value!r}")
                                has_invalid_num = True
                        else:
                            molecule, denominator = frac
                            try:
                                probabilities[i] = int(molecule) / int(denominator)
                            except ValueError:
                                reporter.error(f"Pool '{pool_id}': invalid probability {value!r}")
                                has_invalid_num = True
                    case int() | float():
                        if value < 0:
                            reporter.error(f"Pool '{pool_id}': probability should greater or equal to 0, not {value}")
                            has_invalid_num = True
                    case _:
                        reporter.error(f"Pool '{pool_id}': invalid probability {value!r}")

            if has_invalid_num:
                continue

            if any(i < 0 for i in probabilities):
                reporter.error(
                    f"Pool '{pool_id}': invalid probabilities {''.join(chr(39) + str(i) + chr(39) for i in probabilities if i < 0)}")
                continue
            if any(i - int(i) > 1e-9 for i in probabilities):
                if abs(sum(probabilities) - 1) > 1e-9:
                    reporter.error(f"Pool '{pool_id}': probabilities must sum to 1")
                    continue
                cdf = np.cumsum(np.asarray(probabilities, dtype=np.float64))
            else:
                sm = sum(probabilities)
                if sm == 0:
                    reporter.error(f"Pool '{pool_id}': no probabilities")
                    continue
                cdf = np.cumsum(np.array([x / sm for x in probabilities], dtype=np.float64))
            cdf[-1] = 1.0

            context.pool_list.append(Pool(cdf=cdf, actions=[]))
            context.pool_id_index[pool_id] = len(context.pool_list) - 1
    else:
        reporter.error("missing pool config 'pools'")
        # help linter learn items MUST NOT be None
        reporter.report()
        return None
    # if any error occurs when initializing items and pools, exit!
    if reporter.report():
        return None
    # ---- build pools end ----

    # ---- build items' draws start ----
    for item_id, item_config in items.items():
        match item_config:
            case {"name": str(), "resolve": {"actions": actions}}:
                item_idx = context.item_id_index[item_id]
                context.item_resolve_list[item_idx].actions.extend(_analyse_actions(context, actions, reporter))
        match item_config:
            case {"name": str(), "on_acquire": actions}:
                item_idx = context.item_id_index[item_id]
                context.item_draw_list[item_idx] = _analyse_actions(context, actions, reporter)
    # ---- build items' draws end ----

    # ---- build pools' draws start ----
    for pool_id, pool_config in pools.items():
        match pool_config:
            case {"entries": [*entries_p]} | {"entities": [*entries_p]} | (list() as entries_p):
                pool_idx = context.pool_id_index[pool_id]
                context.pool_list[pool_idx].actions.extend(
                    _analyse_actions(context, entry.get("actions", []), reporter)
                    for entry in entries_p
                )
    # ---- build pools' draws end ----

    # ---- build initial start ----
    initial_config = config.get("initial")
    if initial_config is not None:
        begin_pool = context.pool_id_index.get(initial_config.get("begin_pool", "begin_pool"))
        if begin_pool is not None:
            context.begin_pool_index = begin_pool
        else:
            reporter.error("'begin_pool' not defined in 'initial'")
        actions = initial_config.get("actions")
        if actions is not None:
            context.initial_actions = _analyse_actions(context, actions, reporter)
        else:
            # initial_actions remains empty
            pass
    else:
        reporter.error("missing initial config 'initial'")
    # ---- build initial end ----

    # ---- build stages start ----
    stages = config.get("stages")
    if stages is not None:
        for stage_id, stage_config in stages.items():
            condition_cfg = stage_config.get("condition")
            if condition_cfg is None:
                reporter.error(f"Stage '{stage_id}: missing parameter 'condition'")
                continue
            condition = _build_condition_tree(context, condition_cfg, reporter)
            if condition is None:
                reporter.error(f"Stage '{stage_id}: invalid condition")
                continue
            context.draw_stage_id_index[stage_id] = len(context.draw_stage_list)
            context.draw_stage_list.append(
                Stage(
                    once=bool(stage_config.get("once", False)),
                    condition=condition,
                )
            )
    else:
        pass
    # ---- build stages end ----

    # ---- build every draw's actions start ----
    every_draw_actions = config.get("every_draw")
    if every_draw_actions is not None:
        context.every_draw_actions.extend(_analyse_actions(context, every_draw_actions, reporter))
    # ---- build every draw's actions end ----

    # ---- build pool draw list start ----
    context.pool_draw_list = [
        DrawPool(pool_index=pool_idx)
        for pool_idx in range(len(context.pool_list))
    ]
    # ---- build pool draw list end ----

    if reporter.report():
        return None
    return context


def termination_builder(config_context: RuntimeConfigContext, terminations: Dict[str, Any]) -> Optional[Tuple[RuntimeCondition, List[int]]]:
    reporter = Reporter()
    termination_condition_cfg = terminations.get("condition")
    condition = None
    if termination_condition_cfg is not None:
        condition = _build_condition_tree(config_context, termination_condition_cfg, reporter)
    else:
        reporter.error("missing condition 'condition'")

    retained_items_idx = []
    bad_id = []
    retained_items = terminations.get("retained_items")
    if retained_items is not None:
        for item_id in retained_items:
            item_idx = config_context.item_id_index.get(item_id)
            if item_idx is None:
                bad_id.append(item_id)
            else:
                retained_items_idx.append(item_idx)
        if bad_id:
            retained_items_idx = []
            msg = " ".join(f"'{item_id}'" for item_id in bad_id)
            reporter.error(f"{retained_items!r}: invalid retained item name{'s' if len(bad_id) > 1 else ''} {msg}")

    if reporter.report() or condition is None:
        return None
    return condition, retained_items_idx


def build(config: Dict[str, Any], terminations: Dict[str, Any]) -> Optional[RuntimeContext]:
    config_context = config_builder(config)
    if config_context is None:
        return None
    termination_result = termination_builder(config_context, terminations)
    if termination_result is None:
        return None
    termination_condition, termination_retained_items_idx = termination_result
    return RuntimeContext(
        begin_pool_index=config_context.begin_pool_index,
        initial_actions=config_context.initial_actions,
        every_draw_actions=config_context.every_draw_actions,
        item_id_index=config_context.item_id_index,
        draw_count_index=config_context.item_id_index.get("draw_count", -1),
        item_list=config_context.item_list,
        item_resolve_list=config_context.item_resolve_list,
        item_draw_list=config_context.item_draw_list,
        pool_id_index=config_context.pool_id_index,
        pool_list=config_context.pool_list,
        pool_draw_list=config_context.pool_draw_list,
        draw_stage_id_index=config_context.draw_stage_id_index,
        draw_stage_list=config_context.draw_stage_list,
        retained_items_index=termination_retained_items_idx,
        termination_tree=termination_condition,
    )
