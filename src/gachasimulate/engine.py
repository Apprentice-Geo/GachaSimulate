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
        self.resolvable_item_indices = [
            item_index
            for item_index, item_resolve in enumerate(self.ctx.item_resolve_list)
            if item_resolve.actions
        ]

    def run_once(self) -> RuntimeState:
        '''
        运行一次完整模拟,多次模拟之间使用同一个 rng 生成器 
        '''
        state = RuntimeState(item_count=len(self.ctx.item_list), rng=self.rng)
        state.rule_execute = [False] * len(self.ctx.rule_list)
        state.active_rule_indices = list(range(len(self.ctx.rule_list)))
        self._execute_actions(state, self.ctx.initial_actions)

        while not state.terminate:
            self._one_draw_cycle(state)

        return state

    def _one_draw_cycle(self, state: RuntimeState) -> None:
        '''
        执行一次主卡池的抽取,并检查 rule 和 terminate 条件树
        '''
        self._execute_actions(state, self.ctx.every_draw_actions)

        # 这里所有池子的单次抽取都被构造成了 Action，需要抽取直接调用
        self._execute_action(state, self.ctx.pool_draw_list[state.main_pool_index])

        self._rule_phase(state)

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
        if node.kind is RuntimeKind.CheckNode:
            left = state.inventory[node.item_index]
            right = node.value
            op = node.op
            # 将比较逻辑内联，避免调用比较函数
            if op is RuntimeOpCode.GE:
                ok = left >= right
            elif op is RuntimeOpCode.EQ:
                ok = left == right
            elif op is RuntimeOpCode.NE:
                ok = left != right
            elif op is RuntimeOpCode.LT:
                ok = left < right
            elif op is RuntimeOpCode.LE:
                ok = left <= right
            elif op is RuntimeOpCode.GT:
                ok = left > right
            else:
                raise RuntimeError(f"Unknown op_code: {op}")

            if ok:
                return True, node.actions or EMPTY_ACTIONS
            return False, EMPTY_ACTIONS

        if node.op is RuntimeOpCode.OR:
            for child in node.children:
                ok, child_actions = self._eval_condition(child, state)
                if ok:
                    if node.actions:
                        if child_actions:
                            return True, node.actions + child_actions
                        return True, node.actions
                    return True, child_actions
            return False, EMPTY_ACTIONS

        if node.op is RuntimeOpCode.AND:
            child_action_list: list[RuntimeAction] | None = None
            for child in node.children:
                ok, child_actions = self._eval_condition(child, state)
                if not ok:
                    return False, EMPTY_ACTIONS
                if child_actions:
                    if child_action_list is None:
                        child_action_list = []
                    child_action_list.extend(child_actions)

            if child_action_list is None:
                return True, node.actions or EMPTY_ACTIONS

            child_actions = tuple(child_action_list)
            if node.actions:
                return True, node.actions + child_actions
            return True, child_actions

        raise ValueError(f"unsupported logic op: {node.op}")
