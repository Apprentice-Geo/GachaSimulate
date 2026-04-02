from __future__ import annotations

import json
from typing import Any

import numpy as np

try:
    from .runtime import (
        Action,
        AddItem,
        CheckNode,
        ConditionNode,
        DrawPool,
        Item,
        LogicNode,
        Pool,
        PoolChange,
        ReduceItem,
        RuntimeContext,
        Stage,
        Termination,
    )
except ImportError:
    from runtime import (
        Action,
        AddItem,
        CheckNode,
        ConditionNode,
        DrawPool,
        Item,
        LogicNode,
        Pool,
        PoolChange,
        ReduceItem,
        RuntimeContext,
        Stage,
        Termination,
    )


class runtime_builder:
    def __init__(self, config_path: str, termination_path: str):
        with open(config_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        with open(termination_path, "r", encoding="utf-8") as f:
            self.termination_config = json.load(f)
        self.rmb_per_roll = 0
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
        self.protected_items_index = []
        self.termination_tree = None


    def _resolve_item_index(self, item_id: str) -> int:
        return self.item_id_index[item_id]
        

    def _resolve_pool_index(self, pool_id: str) -> int:
        if pool_id not in self.pool_id_index:
            raise KeyError(f"unknown pool id: {pool_id}")
        return self.pool_id_index[pool_id]

    def _build_actions(
        self, action_configs: list[dict[str, Any]] | None
    ) -> list[Action]:
        actions: list[Action] = []
        for action_config in action_configs or []:
            action_type = action_config.get("type")

            if action_type == "add_item":
                item_id = action_config.get("id", action_config.get("item_id"))
                actions.append(
                    AddItem(
                        item_index=self._resolve_item_index(item_id),
                        amount=int(action_config.get("amount", 1)),
                    )
                )
            elif action_type == "reduce_item":
                item_id = action_config.get("id", action_config.get("item_id"))
                actions.append(
                    ReduceItem(
                        item_index=self._resolve_item_index(item_id),
                        amount=int(action_config.get("amount", 1)),
                    )
                )
            elif action_type == "draw_pool":
                pool_id = action_config["pool_id"]
                actions.append(
                    DrawPool(
                        pool_index=self._resolve_pool_index(pool_id),
                    )
                )
            elif action_type == "pool_change":
                pool_id = action_config.get("pool_id", action_config.get("id"))
                actions.append(
                    PoolChange(
                        pool_index=self._resolve_pool_index(pool_id),
                    )
                )
            elif action_type == "termination":
                actions.append(
                    Termination(
                        reason=str(action_config.get("reason", "")),
                    )
                )
            else:
                raise ValueError(f"unsupported action type: {action_type}")

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
            self.item_resolve_list.append([])
            self.item_draw_list.append([])

        economy = self.config.get("economy", {})
        cost_config = economy.get("cost_per_roll") or economy.get("cost_per_draw") or {}
        per_cost_to_rmb = economy.get(
            "per_cost_to_rmb", economy.get("per_cost_to_RMB", 1)
        )
        self.rmb_per_roll = int(
            float(cost_config.get("amount", 0)) * float(per_cost_to_rmb)
        )

    def _build_resolves(self):
        item_draw_config = self.config.get("item_draw", {})
        item_resolve_config = self.config.get("item_resolve", {})

        for item_id, actions_config in item_draw_config.items():
            item_index = self._resolve_item_index(item_id)
            self.item_draw_list[item_index] = self._build_actions(actions_config)

        for item_id, actions_config in item_resolve_config.items():
            item_index = self._resolve_item_index(item_id)
            self.item_resolve_list[item_index] = self._build_actions(actions_config)

        for item_index, item_config in enumerate(self.config.get("items", {}).values()):
            trigger_rule = item_config.get("trigger_rule")
            if trigger_rule and not self.item_draw_list[item_index]:
                self.item_draw_list[item_index] = [
                    DrawPool(pool_index=self._resolve_pool_index(trigger_rule))
                ]

            resolve_result = item_config.get("resolve_result")
            if resolve_result and not self.item_resolve_list[item_index]:
                target_item_id = resolve_result.get("id")
                target_item_index = self._resolve_item_index(target_item_id)
                amount = int(resolve_result.get("amount", 1))
                self.item_resolve_list[item_index] = [
                    ReduceItem(item_index=item_index, amount=1),
                    AddItem(item_index=target_item_index, amount=amount),
                ]

    def _build_pools(self):
        self.pool_id_index.clear()
        self.pool_list.clear()

        pool_sources: list[tuple[str, dict[str, Any]]] = []

        if "drops" in self.config:
            drops = self.config["drops"]
            pool_sources.append((drops.get("name", "main_pool"), drops))

        for pool_id, pool_config in self.config.get("pools", {}).items():
            pool_sources.append((pool_id, pool_config))

        for rule_id, rule_config in self.config.get("trigger_rules", {}).items():
            if rule_config.get("type") == "sub_pool":
                drops = rule_config.get("drops", {})
                pool_sources.append((drops.get("name", rule_id), drops))

        ordered_pool_sources: list[tuple[str, dict[str, Any]]] = []
        seen_pool_ids: set[str] = set()
        for pool_id, pool_config in pool_sources:
            if pool_id in seen_pool_ids:
                continue
            seen_pool_ids.add(pool_id)
            ordered_pool_sources.append((pool_id, pool_config))

        for index, (pool_id, _) in enumerate(ordered_pool_sources):
            self.pool_id_index[pool_id] = index

        for pool_id, pool_config in ordered_pool_sources:
            entries = pool_config.get("entries", [])
            actions: list[Action] = []
            probabilities: list[float] = []

            for entry in entries:
                probabilities.append(float(entry.get("probability", 0.0)))
                entry_type = entry.get("type")

                if entry_type == "item":
                    actions.append(
                        AddItem(
                            item_index=self._resolve_item_index(entry["id"]),
                            amount=int(entry.get("amount", 1)),
                        )
                    )
                elif entry_type == "draw_pool":
                    actions.append(
                        DrawPool(
                            pool_index=self._resolve_pool_index(entry["pool_id"]),
                        )
                    )
                elif entry_type == "pool_change":
                    actions.append(
                        PoolChange(
                            pool_index=self._resolve_pool_index(entry["pool_id"]),
                        )
                    )
                elif entry_type == "termination":
                    actions.append(
                        Termination(
                            reason=str(entry.get("reason", "")),
                        )
                    )
                else:
                    raise ValueError(f"unsupported pool entry type: {entry_type}")

            cdf = np.cumsum(np.asarray(probabilities, dtype=np.float64))
            if cdf.size:
                cdf[-1] = 1.0

            self.pool_list.append(Pool(cdf=cdf, actions=actions))
    
    def _build_pool_draw_list(self):
        self.pool_draw_list.clear()
        for pool_index in range(len(self.pool_list)):
            self.pool_draw_list.append(DrawPool(pool_index=pool_index))

    def _build_stages(self):
        self.draw_stage_id_index.clear()
        self.draw_stage_list.clear()

        stage_sources = self.config.get("stages")
        if stage_sources is None:
            stage_sources = self.config.get("milestones", {})

        for stage_id, stage_config in stage_sources.items():
            if "reward" in stage_config:
                reward = stage_config.get("reward", {})
                condition = CheckNode(
                    subject="draw_count",
                    id=None,
                    op=">=",
                    value=int(stage_config.get("roll_count", 0)),
                    actions=self._build_actions(
                        [
                            {
                                "type": "add_item",
                                "id": reward.get("id"),
                                "amount": reward.get("amount", 1),
                            }
                        ]
                    ),
                )
                stage_once = True
            else:
                condition_config = stage_config.get(
                    "condition", stage_config.get("conditions")
                )
                condition = self._build_termination_tree(condition_config)
                stage_once = bool(stage_config.get("once", False))

            self.draw_stage_id_index[stage_id] = len(self.draw_stage_list)
            self.draw_stage_list.append(
                Stage(
                    once=stage_once,
                    condition=condition,
                )
            )

    def _build_termination_tree(self, ConditionNode):
        if ConditionNode is None:
            return None

        condition_type = ConditionNode.get("type")
        actions_config = ConditionNode.get("actions")
        actions = (
            self._build_actions(actions_config) if actions_config is not None else None
        )

        if condition_type == "logic":
            child_key = "conditions"
            conditions = [
                self._build_termination_tree(child)
                for child in ConditionNode.get(child_key, [])
            ]
            return LogicNode(
                op=ConditionNode.get("op", "OR"),
                conditions=conditions,
                actions=actions,
            )

        if condition_type == "predicate":
            return CheckNode(
                subject=ConditionNode["subject"],
                id=ConditionNode.get("id"),
                op=ConditionNode["op"],
                value=int(ConditionNode.get("value", 0)),
                actions=actions,
            )

        raise ValueError(f"unsupported condition type: {condition_type}")

    def build(self):
        self._build_items()
        self._build_pools()
        self._build_pool_draw_list()
        self._build_resolves()
        self._build_stages()
        self.termination_tree = self._build_termination_tree(
            self.termination_config.get("termination_conditions")
        )
        self.protected_items_index = [
            self._resolve_item_index(item_id)
            for item_id in self.termination_config.get("protected_items", [])
        ]

        return RuntimeContext(
            rmb_per_roll=self.rmb_per_roll,
            begin_pool_index=self.pool_id_index.get("begin_pool", 0),
            item_id_index=self.item_id_index,
            item_list=self.item_list,
            item_resolve_list=self.item_resolve_list,
            item_draw_list=self.item_draw_list,
            pool_id_index=self.pool_id_index,
            pool_list=self.pool_list,
            pool_draw_list=self.pool_draw_list,
            draw_stage_id_index=self.draw_stage_id_index,
            draw_stage_list=self.draw_stage_list,
            protected_items_index=self.protected_items_index,
            termination_tree=self.termination_tree,
        )
