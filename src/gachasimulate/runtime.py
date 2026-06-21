from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar, Dict, List, Literal, Sequence
from enum import IntEnum
import numpy as np


class RuntimeKind(IntEnum):
    Action = 0
    AddItem = 1
    ReduceItem = 2
    SetItem = 3
    DrawPool = 4
    PoolChange = 5
    Termination = 6
    ConditionNode = 7
    LogicNode = 8
    CheckNode = 9


class RuntimeOpCode(IntEnum):
    EQ = 0  # ==, equal
    NE = 1  # !=, not equal
    LT = 2  # <, less than
    LE = 3  # <=, less than or equal
    GT = 4  # >, greater than
    GE = 5  # >=, greater than or equal
    AND = 6  # AND
    OR = 7  # OR
    NOT = 8  # NOT


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    begin_pool_index: int
    initial_actions: List[RuntimeAction]
    every_draw_actions: List[RuntimeAction]
    item_id_index: Dict[str, int]  # 对物品进行编号
    draw_count_index: int
    item_list: List[Item]
    item_resolve_list: List[ItemResolve]  # 分解某个物品时执行的动作
    item_draw_list: List[List[RuntimeAction]]  # 获得物品时执行的动作
    pool_id_index: Dict[str, int]  # 对池子进行编号
    pool_list: List[Pool]
    pool_draw_list: List[
        RuntimeAction
    ]  # 供engine直接调用的抽卡动作,对每一个池子构建一个DrawPool动作
    draw_stage_id_index: Dict[str, int]  # 对阶段进行编号
    draw_stage_list: List[Stage]
    retained_items_index: List[int]
    termination_tree: RuntimeCondition


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
    kind: ClassVar[RuntimeKind] = RuntimeKind.Action

    @abstractmethod
    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        pass


@dataclass(frozen=True, slots=True)
class AddItem(Action):
    kind: ClassVar[Literal[RuntimeKind.AddItem]] = RuntimeKind.AddItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] += self.amount
        runtime_state.acquired[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class ReduceItem(Action):
    kind: ClassVar[Literal[RuntimeKind.ReduceItem]] = RuntimeKind.ReduceItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] -= self.amount
        runtime_state.reduced[self.item_index] += self.amount


@dataclass(frozen=True, slots=True)
class SetItem(Action):
    kind: ClassVar[Literal[RuntimeKind.SetItem]] = RuntimeKind.SetItem

    item_index: int
    amount: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.inventory[self.item_index] = self.amount


@dataclass(frozen=True, slots=True)
class DrawPool(Action):
    kind: ClassVar[Literal[RuntimeKind.DrawPool]] = RuntimeKind.DrawPool

    pool_index: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> List[RuntimeAction]:
        r = runtime_state.rng.random()
        idx = np.searchsorted(runtime_context.pool_list[self.pool_index].cdf, r)
        actions = runtime_context.pool_list[self.pool_index].actions[idx]
        return actions


@dataclass(frozen=True, slots=True)
class PoolChange(Action):
    kind: ClassVar[Literal[RuntimeKind.PoolChange]] = RuntimeKind.PoolChange

    pool_index: int

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.main_pool_index = self.pool_index


@dataclass(frozen=True, slots=True)
class Termination(Action):
    kind: ClassVar[Literal[RuntimeKind.Termination]] = RuntimeKind.Termination

    reason: str

    def execute(self, runtime_state: RuntimeState, runtime_context: RuntimeContext):
        runtime_state.terminate = True
        runtime_state.terminate_reason = self.reason


type RuntimeAction = AddItem | ReduceItem | SetItem | DrawPool | PoolChange | Termination


class ConditionNode(ABC):
    kind: ClassVar[RuntimeKind] = RuntimeKind.ConditionNode


@dataclass(frozen=True, slots=True)
class LogicNode(ConditionNode):
    kind: ClassVar[Literal[RuntimeKind.LogicNode]] = RuntimeKind.LogicNode

    op: int
    conditions: Sequence[RuntimeCondition]
    actions: List[RuntimeAction] | None


@dataclass(frozen=True, slots=True)
class CheckNode(ConditionNode):
    kind: ClassVar[Literal[RuntimeKind.CheckNode]] = RuntimeKind.CheckNode

    item_index: int
    op: int
    value: int
    actions: List[RuntimeAction] | None


type RuntimeCondition = LogicNode | CheckNode


@dataclass(frozen=True, slots=True)
class Stage:
    once: bool
    condition: RuntimeCondition


@dataclass(frozen=True, slots=True)
class Pool:
    cdf: np.ndarray
    actions: List[List[RuntimeAction]]


@dataclass(frozen=True, slots=True)
class Item:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class ItemResolve:
    retain: int
    actions: List[RuntimeAction]
