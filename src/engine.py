from __future__ import annotations

from collections import deque
from typing import Deque, Iterable

try:
    from .runtime import (
        Action,
        AddItem,
        CheckNode,
        ConditionNode,
        DrawPool,
        LogicNode,
        ReduceItem,
        RuntimeContext,
        RuntimeState,
        Termination,
    )
except ImportError:
    from runtime import (
        Action,
        AddItem,
        CheckNode,
        ConditionNode,
        DrawPool,
        LogicNode,
        ReduceItem,
        RuntimeContext,
        RuntimeState,
        Termination,
    )


class montecarlo:
    def __init__(self, ctx: RuntimeContext, seed=None):
        self.ctx = ctx
        self.seed = seed
        self._protected_snapshot: tuple[int, ...] = ()

    def run_once(self) -> RuntimeState:
        state = RuntimeState(item_count=len(self.ctx.item_list), seed=self.seed)
        state.main_pool_index = self.ctx.begin_pool_index
        state.stage_execute = [False] * len(self.ctx.draw_stage_list)
        self._protected_snapshot = self._get_protected_inventory_snapshot(state)

        while not state.terminate:
            self._one_draw_cycle(state)

        return state

    def _one_draw_cycle(self, state: RuntimeState) -> None:
        action_queue: Deque[Action] = deque()

        state.draw_count += 1
        state.rmb_cost += self.ctx.rmb_per_roll

        action_queue.append(self.ctx.pool_draw_list[state.main_pool_index])
        self._drain_action_queue(state, action_queue)

        self._stage_phase(state, action_queue)
        self._drain_action_queue(state, action_queue)

        self._resolve_phase(state, action_queue)
        self._drain_action_queue(state, action_queue)

        if self._should_check_termination(state):
            should_terminate, termination_actions = self._eval_condition(
                self.ctx.termination_tree, state
            )
            if should_terminate:
                self._enqueue_actions(action_queue, termination_actions)
                self._drain_action_queue(state, action_queue)

    def _stage_phase(self, state: RuntimeState, action_queue: Deque[Action]) -> None:
        for stage_index, stage in enumerate(self.ctx.draw_stage_list):
            if stage.once and state.stage_execute[stage_index]:
                continue

            ok, stage_actions = self._eval_condition(stage.condition, state)
            if ok:
                self._enqueue_actions(action_queue, stage_actions)
                if stage.once:
                    state.stage_execute[stage_index] = True

    def _resolve_phase(self, state: RuntimeState, action_queue: Deque[Action]) -> None:
        protected = set(self.ctx.protected_items_index)

        for item_index, resolve_actions in enumerate(self.ctx.item_resolve_list):
            if item_index in protected:
                continue
            if not resolve_actions:
                continue

            count = int(state.inventory[item_index])
            if count <= 0:
                continue

            for _ in range(count):
                self._enqueue_actions(action_queue, resolve_actions)

    def _drain_action_queue(
        self, state: RuntimeState, action_queue: Deque[Action]
    ) -> None:
        max_steps = 1_000_000
        steps = 0

        while action_queue and not state.terminate:
            steps += 1
            if steps > max_steps:
                raise RuntimeError(
                    "action queue exceeded max steps; possible action loop"
                )

            action = action_queue.popleft()
            self._apply_action(action, state, action_queue)

    def _apply_action(
        self, action: Action, state: RuntimeState, action_queue: Deque[Action]
    ) -> None:
        if isinstance(action, AddItem):
            action.execute(state, self.ctx)

            draw_actions = self.ctx.item_draw_list[action.item_index]
            if draw_actions:
                for _ in range(action.amount):
                    self._enqueue_actions(action_queue, draw_actions)
            return

        if isinstance(action, (DrawPool, ReduceItem, Termination)):
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
        if subject == "rmb_cost":
            return state.rmb_cost
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

    def _get_protected_inventory_snapshot(self, state: RuntimeState) -> tuple[int, ...]:
        if not self.ctx.protected_items_index:
            return ()
        return tuple(int(state.inventory[i]) for i in self.ctx.protected_items_index)

    def _should_check_termination(self, state: RuntimeState) -> bool:
        # Keep compatibility with configs that do not define protected items.
        if not self.ctx.protected_items_index:
            return True

        current_snapshot = self._get_protected_inventory_snapshot(state)
        if current_snapshot == self._protected_snapshot:
            return False

        self._protected_snapshot = current_snapshot
        return True

    def _enqueue_actions(
        self, action_queue: Deque[Action], actions: Iterable[Action] | None
    ) -> None:
        for action in actions or []:
            action_queue.append(action)
