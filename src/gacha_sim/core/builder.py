from __future__ import annotations

import json
from typing import Any
from .validator import validate_config, validate_files, validate_termination
import numpy as np

from gacha_sim.core.runtime import (
    Action,
    AddItem,
    CheckNode,
    ConditionNode,
    DrawPool,
    Item,
    ItemResolve,
    LogicNode,
    Pool,
    PoolChange,
    ReduceItem,
    RuntimeContext,
    SetItem,
    Stage,
    Termination,
)


class runtime_builder:
    def __init__(self, config_path: str, termination_path: str):
        validate_files(config_path, termination_path)
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        with open(termination_path, "r", encoding="utf-8") as f:
            self.termination_config = json.load(f)
        self._init_runtime_storage()

    @classmethod
    def from_config(
        cls, config: dict[str, Any], termination_config: dict[str, Any]
    ) -> "runtime_builder":
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
        self.initial_actions = []
        self.termination_tree = None

    def _resolve_item_index(self, item_id: str) -> int:
        return self.item_id_index[item_id]

    def _resolve_pool_index(self, pool_id: str) -> int:
        return self.pool_id_index[pool_id]

    def _build_action(self, action_config: dict[str, Any]) -> Action:
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

    def _build_actions(
        self, action_configs: list[dict[str, Any]] | None
    ) -> list[Action]:
        actions: list[Action] = []
        for action_config in action_configs or []:
            actions.append(self._build_action(action_config))
        return actions

    def _build_items(self):
        self.item_id_index.clear()
        self.item_list.clear()
        self.item_resolve_list.clear()
        self.item_draw_list.clear()

        for index, (item_id, item_config) in enumerate(
            self.config.get("items", {}).items()
        ):
            self.item_id_index[item_id] = index
            self.item_list.append(
                Item(
                    id=item_id,
                    name=item_config.get("name", ""),
                )
            )
            self.item_resolve_list.append(ItemResolve(retain=0, actions=[]))
            self.item_draw_list.append([])

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
            actions: list[list[Action]] = []
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
            condition = self._build_termination_tree(condition_config)
            stage_once = bool(stage_config.get("once", False))

            self.draw_stage_id_index[stage_id] = len(self.draw_stage_list)
            self.draw_stage_list.append(
                Stage(
                    once=stage_once,
                    condition=condition,
                )
            )

    def _build_termination_tree(self, condition_config: dict[str, Any] | None):
        if condition_config is None:
            return None

        condition_type = condition_config.get("type")
        actions_config = condition_config.get("actions")
        actions = (
            self._build_actions(actions_config) if actions_config is not None else None
        )

        if condition_type == "logic":
            conditions = [
                self._build_termination_tree(child)
                for child in condition_config.get("conditions", [])
            ]
            return LogicNode(
                op=condition_config.get("op", "OR"),
                conditions=conditions,
                actions=actions,
            )

        if condition_type == "predicate":
            return CheckNode(
                subject=condition_config["subject"],
                id=condition_config.get("id"),
                op=condition_config["op"],
                value=int(condition_config.get("value", 0)),
                actions=actions,
            )

        raise ValueError(f"unsupported condition type: {condition_type}")

    def build(self):
        self._build_items()
        self._build_pools()
        self._build_initial()
        self._build_pool_draw_list()
        self._build_item_draws()
        self._build_item_resolves()
        self._build_stages()
        self.termination_tree = self._build_termination_tree(
            self.termination_config["termination_condition"]
        )
        self.retained_items_index = [
            self._resolve_item_index(item_id)
            for item_id in self.termination_config.get("retained_items", [])
        ]

        return RuntimeContext(
            begin_pool_index=self.begin_pool_index,
            initial_actions=self.initial_actions,
            item_id_index=self.item_id_index,
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
