from __future__ import annotations
import numpy as np
from typing import Iterable

from simulate.runtime import (
    Action,
    ConditionNode,
    RUNTIME_KIND,
    RuntimeContext,
    RuntimeState,
)


class MonteCarlo:
    def __init__(self, ctx: RuntimeContext, seed=None):
        self.ctx = ctx
        self.seed = seed
        # 此处定义全局rng,避免多次模拟时重复创建同一个种子的rng,导致每次模拟结果重复
        self.rng = np.random.default_rng(self.seed)
        # 记录可分解的物品索引
        self.resolvable_item_indices = [
            item_index
            for item_index, item_resolve in enumerate(self.ctx.item_resolve_list)
            if item_resolve.actions
        ]
        self.retained_items_index_set = set(self.ctx.retained_items_index)

    def run_once(self) -> RuntimeState:
        state = RuntimeState(item_count=len(self.ctx.item_list), rng=self.rng)
        state.main_pool_index = self.ctx.begin_pool_index
        state.stage_execute = [False] * len(self.ctx.draw_stage_list)
        state.active_stage_indices = list(range(len(self.ctx.draw_stage_list)))
        self._execute_actions(state, self.ctx.initial_actions)

        while not state.terminate:
            self._one_draw_cycle(state)

        return state

    def _one_draw_cycle(self, state: RuntimeState) -> None:
        self._execute_actions(state, self.ctx.every_draw_actions)

        # 这里所有池子的单次抽取都被构造成了 Action，需要抽取直接调用
        self._execute_action(state, self.ctx.pool_draw_list[state.main_pool_index])

        self._stage_phase(state)
        # 只要 resolve 不会产生还需要 resolve 的物品，就不会出错
        self._resolve_phase(state)

        should_terminate, termination_actions = self._eval_condition(
            self.ctx.termination_tree, state
        )
        if should_terminate:
            self._execute_actions(state, termination_actions)

    def _stage_phase(self, state: RuntimeState) -> None:
        active_stage_pos = 0
        while active_stage_pos < len(state.active_stage_indices):
            stage_index = state.active_stage_indices[active_stage_pos]
            stage = self.ctx.draw_stage_list[stage_index]

            ok, stage_actions = self._eval_condition(stage.condition, state)
            if ok:
                state.stage_execute[stage_index] = True
                if stage.once:
                    state.active_stage_indices.pop(active_stage_pos)
                else:
                    active_stage_pos += 1
                self._execute_actions(state, stage_actions)
                # 由于之前已经执行了 pop 或者 +=1，continue 以后不会重复触发同一个 stage
                continue

            active_stage_pos += 1

    def _resolve_phase(self, state: RuntimeState) -> None:
        for item_index in self.resolvable_item_indices:
            item_resolve = self.ctx.item_resolve_list[item_index]
            count = int(state.inventory[item_index])
            retain = max(
                item_resolve.retain,
                int(item_index in self.retained_items_index_set),
            )
            resolve_count = count - retain
            if resolve_count <= 0:
                continue

            # 执行 resolve_count 次分解
            for _ in range(resolve_count):
                self._execute_actions(state, item_resolve.actions)

    def _execute_actions(self, state: RuntimeState, actions: Iterable[Action] | None) -> None:
        if not actions:
            return
        for action in actions:
            if state.terminate:
                return
            self._execute_action(state, action)

    def _execute_action(self, state: RuntimeState, action: Action) -> None:
        kind = action.kind

        if kind == RUNTIME_KIND.AddItem:
            action.execute(state, self.ctx)

            # 直接触发带有二级池子物品的抽取
            draw_actions = self.ctx.item_draw_list[action.item_index]
            if draw_actions:
                for _ in range(action.amount):
                    self._execute_actions(state, draw_actions)
            return

        if kind == RUNTIME_KIND.DrawPool:
            drawn_results = action.execute(state, self.ctx)
            self._execute_actions(state, drawn_results)
            return

        if kind in (
            RUNTIME_KIND.ReduceItem,
            RUNTIME_KIND.SetItem,
            RUNTIME_KIND.PoolChange,
            RUNTIME_KIND.Termination,
        ):
            action.execute(state, self.ctx)
            return

        raise TypeError(f"unsupported action kind: {kind}")

    def _eval_condition(
            self, node: ConditionNode | None, state: RuntimeState
    ) -> tuple[bool, list[Action]]:
        if node is None:
            return False, []

        kind = node.kind

        if kind == RUNTIME_KIND.CheckNode:
            left = int(state.inventory[node.item_index])
            ok = self._compare(left, node.op, node.value)
            if ok:
                return True, list(node.actions or [])
            return False, []

        if kind == RUNTIME_KIND.LogicNode:
            if node.op == "OR":
                for child in node.conditions:
                    ok, child_actions = self._eval_condition(child, state)
                    if ok:
                        # actions = node.actions if node.actions else []
                        # actions.extend(child_actions)
                        return True, node.actions + child_actions if node.actions else child_actions
                return False, []
            case LogicNode(op="AND"):
                aggregated: list[Action] = []
                for child in node.conditions:
                    ok, child_actions = self._eval_condition(child, state)
                    if not ok:
                        return False, []
                    aggregated.extend(child_actions)
                return True,  node.actions + aggregated if node.actions else aggregated

            raise ValueError(f"unsupported logic op: {node.op}")

        raise TypeError(f"unsupported condition node type: {type(node).__name__}")

    def _compare(self, left: int, op: str, right: int) -> bool:
        match op:
            case ">=":
                return left >= right
            case "<=":
                return left <= right
            case "!=":
                return left != right
            case "==":
                return left == right
            case ">":
                return left > right
            case "<":
                return left < right
            case _:
                raise ValueError(f"unsupported predicate op: {op}")
