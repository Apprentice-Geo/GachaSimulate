from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List, Sequence

import numpy as np


@dataclass(frozen=True, slots=True)
class RuntimeKind:
    Action: int = 0
    AddItem: int = 1
    ReduceItem: int = 2
    SetItem: int = 3
    DrawPool: int = 4
    PoolChange: int = 5
    Termination: int = 6
    ConditionNode: int = 7
    LogicNode: int = 8
    CheckNode: int = 9


RUNTIME_KIND = RuntimeKind()


@dataclass(frozen=True, slots=True)
class RuntimeOpCode:
    EQ: int = 0  # ==, equal
    NE: int = 1  # !=, not equal
    LT: int = 2  # <, less than
    LE: int = 3  # <=, less than or equal
    GT: int = 4  # >, greater than
    GE: int = 5  # >=, greater than or equal
    AND: int = 6  # AND
    OR: int = 7  # OR
    NOT: int = 8  # NOT


RUNTIME_OP_CODE = RuntimeOpCode()


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    begin_pool_index: int
    initial_actions: List[Action]
    every_draw_actions: List[Action]
    item_id_index: Dict[str, int]  # 对物品进行编号
    draw_count_index: int
    every_draw_actions: List[Action]
    item_id_index: Dict[str, int]  # 对物品进行编号
    draw_count_index: int
    item_list: List[Item]
    item_resolve_list: List[ItemResolve]  # 分解某个物品时执行的动作
    item_draw_list: List[List[Action]]  # 获得物品时执行的动作
    pool_id_index: Dict[str, int]  # 对池子进行编号
    item_resolve_list: List[ItemResolve]  # 分解某个物品时执行的动作
    item_draw_list: List[List[Action]]  # 获得物品时执行的动作
    pool_id_index: Dict[str, int]  # 对池子进行编号
    pool_list: List[Pool]
    pool_draw_list: List[Action]  # 供engine直接调用的抽卡动作,对每一个池子构建一个DrawPool动作
    draw_stage_id_index: Dict[str, int]  # 对阶段进行编号
    draw_stage_id_index: Dict[str, int]  # 对阶段进行编号
    draw_stage_list: List[Stage]
    retained_items_index: List[int]
    termination_tree: LogicNode | CheckNode
    termination_tree: LogicNode | CheckNode


class RuntimeState:
    __slots__ = (
        "rng",
        "main_pool_index",
        "stage_execute",
        "active_stage_indices",
        "inventory",  # 规则用库存
        "acquired",  # 统计用累计获得
        "reduced",  # 统计用累计消耗
        "terminate",
        "terminate_reason",
    )

    def __init__(self, item_count: int, rng: np.random.Generator):
        self.rng = rng
        self.main_pool_index = 0
        self.stage_execute = []
        self.active_stage_indices = []
        self.inventory = np.zeros(item_count, dtype=np.int32)
        self.acquired = np.zeros(item_count, dtype=np.int32)
        self.reduced = np.zeros(item_count, dtype=np.int32)
        self.terminate = False
        self.terminate_reason: str | None = None


class Action(ABC):
    kind = RUNTIME_KIND.Action

    kind = RUNTIME_KIND.Action

    @abstractmethod
    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        pass


@dataclass(frozen=True, slots=True)
class AddItem(Action):
    kind = RUNTIME_KIND.AddItem

    kind = RUNTIME_KIND.AddItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] += self.amount
        runtime_state.acquired[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class ReduceItem(Action):
    kind = RUNTIME_KIND.ReduceItem

    kind = RUNTIME_KIND.ReduceItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] -= self.amount
        runtime_state.reduced[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class SetItem(Action):
    kind = RUNTIME_KIND.SetItem

    kind = RUNTIME_KIND.SetItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] = self.amount


@dataclass(frozen=True, slots=True)
class DrawPool(Action):
    kind = RUNTIME_KIND.DrawPool

    kind = RUNTIME_KIND.DrawPool

    pool_index: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext) -> List[Action]:
        r = runtime_state.rng.random()
        idx = np.searchsorted(runtime_context.pool_list[self.pool_index].cdf, r)
        actions = runtime_context.pool_list[self.pool_index].actions[idx]
        return actions


@dataclass(frozen=True, slots=True)
class PoolChange(Action):
    kind = RUNTIME_KIND.PoolChange

    kind = RUNTIME_KIND.PoolChange

    pool_index: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.main_pool_index = self.pool_index


@dataclass(frozen=True, slots=True)
class Termination(Action):
    kind = RUNTIME_KIND.Termination

    kind = RUNTIME_KIND.Termination

    reason: str

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.terminate = True
        runtime_state.terminate_reason = self.reason


class ConditionNode(ABC):
    kind = RUNTIME_KIND.ConditionNode
class ConditionNode(ABC):
    kind = RUNTIME_KIND.ConditionNode


@dataclass(frozen=True, slots=True)
class LogicNode(ConditionNode):
    kind = RUNTIME_KIND.LogicNode

    op: int
    conditions: Sequence[LogicNode | CheckNode]
    actions: List[Action] | None


@dataclass(frozen=True, slots=True)
class CheckNode(ConditionNode):
    kind = RUNTIME_KIND.CheckNode

    item_index: int
    op: int
    kind = RUNTIME_KIND.CheckNode

    item_index: int
    op: int
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


@dataclass(frozen=True, slots=True)
class ItemResolve:
    retain: int
    actions: List[Action]
