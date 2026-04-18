from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List

import numpy as np


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    rmb_per_draw: int
    begin_pool_index: int
    item_id_index: Dict[str, int]
    item_list: List[Item]
    item_resolve_list: List[List[Action]]  # resolve 某个物品时执行的动作
    item_draw_list: List[List[Action]]
    pool_id_index: Dict[str, int]
    pool_list: List[Pool]
    pool_draw_list: List[Action]  # 供engine直接调用的抽卡动作,对每一个池子构建一个DrawPool动作
    draw_stage_id_index: Dict[str, int]
    draw_stage_list: List[Stage]
    protected_items_index: List[int]
    termination_tree: ConditionNode


class RuntimeState:
    __slots__ = (
        "rng",
        "main_pool_index",
        "stage_execute",
        "inventory",  # 规则用库存
        "acquired",  # 统计用累计获得
        "reduced",  # 统计用累计消耗
        "draw_count",
        "rmb_cost",
        "terminate",
        "terminate_reason",
    )

    def __init__(self, item_count: int, rng: np.random.Generator):
        self.rng = rng
        self.main_pool_index = 0
        self.stage_execute = []
        self.inventory = np.zeros(item_count, dtype=np.int32)
        self.acquired = np.zeros(item_count, dtype=np.int32)
        self.reduced = np.zeros(item_count, dtype=np.int32)
        self.draw_count = 0
        self.rmb_cost = 0
        self.terminate = False
        self.terminate_reason = None


class Action(ABC):
    @abstractmethod
    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        pass


@dataclass(frozen=True, slots=True)
class AddItem(Action):
    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] += self.amount
        runtime_state.acquired[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class ReduceItem(Action):
    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] -= self.amount
        runtime_state.reduced[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class DrawPool(Action):
    pool_index: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> Action:
        r = runtime_state.rng.random()
        idx = np.searchsorted(runtime_context.pool_list[self.pool_index].cdf, r)
        actions = runtime_context.pool_list[self.pool_index].actions[idx]
        return actions


@dataclass(frozen=True, slots=True)
class PoolChange(Action):
    pool_index: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.main_pool_index = self.pool_index


@dataclass(frozen=True, slots=True)
class Termination(Action):
    reason: str

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.terminate = True
        runtime_state.terminate_reason = self.reason


class ConditionNode(ABC): ...


@dataclass(frozen=True, slots=True)
class LogicNode(ConditionNode):
    op: str
    conditions: List[ConditionNode]
    actions: List[Action] | None


@dataclass(frozen=True, slots=True)
class CheckNode(ConditionNode):
    subject: str
    id: str
    op: str
    value: int
    actions: List[Action] | None


@dataclass(frozen=True, slots=True)
class Stage:
    once: bool
    condition: ConditionNode


@dataclass(frozen=True, slots=True)
class Pool:
    cdf: np.ndarray
    actions: List[List[Action]]


@dataclass(frozen=True, slots=True)
class Item:
    id: str
    name: str
