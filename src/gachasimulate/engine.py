from __future__ import annotations
import numpy as np
from typing import Iterable

from .runtime import (
    RuntimeAction,
    RuntimeCondition,
    RuntimeKind,
    RuntimeOpCode,
    RuntimeContext,
    RuntimeState,
    EMPTY_ACTIONS,
)


class MonteCarlo:
    def __init__(self, ctx: RuntimeContext, seed=None):
        self.ctx = ctx
        self.seed = seed
        # 此处定义全局rng,避免多次模拟时重复创建同一个种子的rng,导致每次模拟结果重复
        self.rng = np.random.default_rng(self.seed)
        # 记录可分解的物品索引
        # 记录可分解的物品索引
        self.resolvable_item_indices = [
            item_index
            for item_index, item_resolve in enumerate(self.ctx.item_resolve_list)
            if item_resolve.actions
        ]

    def run_once(self) -> RuntimeState:
        state = RuntimeState(item_count=len(self.ctx.item_list), rng=self.rng)
        state.rule_execute = [False] * len(self.ctx.rule_list)
        state.active_rule_indices = list(range(len(self.ctx.rule_list)))
        self._execute_actions(state, self.ctx.initial_actions)

        while not state.terminate:
            self._one_draw_cycle(state)

        return state

    def _one_draw_cycle(self, state: RuntimeState) -> None:
        self._execute_actions(state, self.ctx.every_draw_actions)

        # 这里所有池子的单次抽取都被构造成了 Action，需要抽取直接调用
        self._execute_action(state, self.ctx.pool_draw_list[state.main_pool_index])

        self._rule_phase(state)
        # 只要 resolve 不会产生还需要 resolve 的物品，就不会出错
        # self._resolve_phase(state) 分解已经写在 AddItem 的执行中，因此这个注释掉不影响

        should_terminate, termination_actions = self._eval_condition(
            self.ctx.termination_tree, state
        )
        if should_terminate:
            self._execute_actions(state, termination_actions)

    def _rule_phase(self, state: RuntimeState) -> None:
        active_rule_pos = 0
        while active_rule_pos < len(state.active_rule_indices):
            rule_index = state.active_rule_indices[active_rule_pos]
            rule = self.ctx.rule_list[rule_index]

            ok, rule_actions = self._eval_condition(rule.condition, state)
            if ok:
                state.rule_execute[rule_index] = True
                self._execute_actions(state, rule_actions)
                if state.terminate:
                    return
                if rule.mode == "once":
                    state.active_rule_indices.pop(active_rule_pos)
                elif rule.mode == "repeat":
                    continue
                else:
                    active_rule_pos += 1
                continue

            active_rule_pos += 1

    def _resolve_phase(self, state: RuntimeState) -> None:
        for item_index in self.resolvable_item_indices:
            item_resolve = self.ctx.item_resolve_list[item_index]
            count = int(state.inventory[item_index])
            retain = item_resolve.retain
            resolve_count = count - retain
            if resolve_count <= 0:
                continue

            # 执行 resolve_count 次分解
            for _ in range(resolve_count):
                self._execute_actions(state, item_resolve.actions)

    def _execute_actions(
        self, state: RuntimeState, actions: Iterable[RuntimeAction] | None
        self, state: RuntimeState, actions: Iterable[RuntimeAction] | None
    ) -> None:
        if not actions:
            return
        for action in actions:
            if state.terminate:
                return
            self._execute_action(state, action)

    def _execute_action(self, state: RuntimeState, action: RuntimeAction) -> None:
        next_actions = action.execute(state, self.ctx)
        if next_actions:
            self._execute_actions(state, next_actions)

    def _eval_condition(
        self, node: RuntimeCondition, state: RuntimeState
    ) -> tuple[bool, tuple[RuntimeAction, ...]]:
        match node.kind:
            case RuntimeKind.CheckNode:
                left = int(state.inventory[node.item_index])
                ok = self._compare(left, node.op, node.value)
                if ok:
                    return True, node.actions or EMPTY_ACTIONS
                return False, EMPTY_ACTIONS

            case RuntimeKind.LogicNode:
                match node.op:
                    case RuntimeOpCode.OR:
                        for child in node.children:
                            ok, child_actions = self._eval_condition(child, state)
                            if ok:
                                return (
                                    True,
                                    node.actions + child_actions if node.actions else child_actions,
                                )
                        return False, EMPTY_ACTIONS
                    case RuntimeOpCode.AND:
                        aggregated: tuple[RuntimeAction, ...] = ()
                        for child in node.children:
                            ok, child_actions = self._eval_condition(child, state)
                            if not ok:
                                return False, EMPTY_ACTIONS
                            aggregated += child_actions
                        return True, node.actions + aggregated if node.actions else aggregated

                raise ValueError(f"unsupported logic op: {node.op}")

        raise TypeError(f"unsupported condition node type: {type(node).__name__}")

    def _compare(self, left: int, op_code: RuntimeOpCode, right: int) -> bool:
        if op_code == RuntimeOpCode.EQ:
            return left == right
        if op_code == RuntimeOpCode.NE:
            return left != right
        if op_code == RuntimeOpCode.LT:
            return left < right
        if op_code == RuntimeOpCode.LE:
            return left <= right
        if op_code == RuntimeOpCode.GT:
            return left > right
        if op_code == RuntimeOpCode.GE:
            return left >= right
        raise RuntimeError(f"Unknown op_code: {op_code}")
