from __future__ import annotations
import numpy as np
from typing import Iterable


from gacha_sim.core.runtime import (
    Action,
    AddItem,
    CheckNode,
    ConditionNode,
    DrawPool,
    LogicNode,
    ReduceItem,
    RuntimeContext,
    RuntimeState,
    SetItem,
    Termination,
)


class montecarlo:
    def __init__(self, ctx: RuntimeContext, seed=None):
        self.ctx = ctx
        self.seed = seed
        # 此处定义全局rng,避免多次模拟时重复创建同一个种子的rng,导致每次模拟结果重复
        self.rng = np.random.default_rng(self.seed)

    def run_once(self) -> RuntimeState:
        state = RuntimeState(item_count=len(self.ctx.item_list), rng=self.rng)
        state.main_pool_index = self.ctx.begin_pool_index
        state.stage_execute = [False] * len(self.ctx.draw_stage_list)

        while not state.terminate:
            self._one_draw_cycle(state)

        return state

    def _one_draw_cycle(self, state: RuntimeState) -> None:
        state.draw_count += 1

        self._execute_action(state, self.ctx.pool_draw_list[state.main_pool_index])

        self._stage_phase(state)
        self._resolve_phase(state)

        should_terminate, termination_actions = self._eval_condition(
            self.ctx.termination_tree, state
        )
        if should_terminate:
            self._execute_actions(state, termination_actions)

    def _stage_phase(self, state: RuntimeState) -> None:
        for stage_index, stage in enumerate(self.ctx.draw_stage_list):
            if stage.once and state.stage_execute[stage_index]:
                continue

            ok, stage_actions = self._eval_condition(stage.condition, state)
            if ok:
                if stage.once:
                    state.stage_execute[stage_index] = True
                self._execute_actions(state, stage_actions)

    def _resolve_phase(self, state: RuntimeState) -> None:
        retained = set(self.ctx.retained_items_index)

        for item_index, item_resolve in enumerate(self.ctx.item_resolve_list):
            if not item_resolve.actions:
                continue

            count = int(state.inventory[item_index])
            retain = max(item_resolve.retain, 1 if item_index in retained else 0)
            resolve_count = count - retain
            if resolve_count <= 0:
                continue

            for _ in range(resolve_count):
                self._execute_actions(state, item_resolve.actions)

    def _execute_actions(
        self, state: RuntimeState, actions: Iterable[Action] | None
    ) -> None:
        for action in actions or []:
            if state.terminate:
                return
            self._execute_action(state, action)

    def _execute_action(self, state: RuntimeState, action: Action) -> None:
        if isinstance(action, AddItem):
            action.execute(state, self.ctx)

            draw_actions = self.ctx.item_draw_list[action.item_index]
            if draw_actions:
                for _ in range(action.amount):
                    self._execute_actions(state, draw_actions)
            return

        if isinstance(action, DrawPool):
            drawn_results = action.execute(state, self.ctx)
            self._execute_actions(state, drawn_results)
            return

        if isinstance(action, (ReduceItem, SetItem, Termination)):
            action.execute(state, self.ctx)
            return

        action.execute(state, self.ctx)

    def _eval_condition(
        self, node: ConditionNode | None, state: RuntimeState
    ) -> tuple[bool, list[Action]]:
        if node is None:
            return False, []

        if isinstance(node, CheckNode):
            left = self._get_subject_value(node.subject, node.id, state)
            ok = self._compare(left, node.op, node.value)
            if ok:
                return True, list(node.actions or [])
            return False, []

        if isinstance(node, LogicNode):
            if node.op == "OR":
                for child in node.conditions:
                    ok, child_actions = self._eval_condition(child, state)
                    if ok:
                        actions = list(node.actions or [])
                        actions.extend(child_actions)
                        return True, actions
                return False, []

            if node.op == "AND":
                aggregated: list[Action] = []
                for child in node.conditions:
                    ok, child_actions = self._eval_condition(child, state)
                    if not ok:
                        return False, []
                    aggregated.extend(child_actions)
                actions = list(node.actions or [])
                actions.extend(aggregated)
                return True, actions

            raise ValueError(f"unsupported logic op: {node.op}")

        raise TypeError(f"unsupported condition node type: {type(node).__name__}")

    def _get_subject_value(
        self, subject: str, subject_id: str | None, state: RuntimeState
    ) -> int:
        if subject == "draw_count":
            return state.draw_count
        if subject == "item":
            if subject_id is None:
                raise ValueError("item predicate requires id")
            return int(state.inventory[self.ctx.item_id_index[subject_id]])

        raise ValueError(f"unsupported predicate subject: {subject}")

    def _compare(self, left: int, op: str, right: int) -> bool:
        if op == ">=":
            return left >= right
        if op == ">":
            return left > right
        if op == "==":
            return left == right
        if op == "<=":
            return left <= right
        if op == "<":
            return left < right
        if op == "!=":
            return left != right

        raise ValueError(f"unsupported predicate op: {op}")
