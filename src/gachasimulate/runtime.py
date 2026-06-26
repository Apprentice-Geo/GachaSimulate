from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import ClassVar, Dict, List, Literal, Sequence, Optional, TextIO
from enum import IntEnum, Enum, auto
import numpy as np


class RuntimeKind(IntEnum):
    Action = auto()
    AddItem = auto()
    ReduceItem = auto()
    SetItem = auto()
    DrawPool = auto()
    PoolChange = auto()
    Termination = auto()
    ConditionNode = auto()
    LogicNode = auto()
    CheckNode = auto()


class RuntimeOpCode(Enum):
    EQ = "=="
    NE = "!="
    LT = "<"
    LE = "<="
    GT = ">"
    GE = ">="
    AND = "AND"
    OR = "OR"
    XOR = "XOR"
    NOT = "NOT"


@dataclass(frozen=False, slots=True)
class RuntimeConfigContext:
    begin_pool_index: int = 0
    initial_actions: List[RuntimeAction] = field(default_factory=list)
    every_draw_actions: List[RuntimeAction] = field(default_factory=list)
    item_id_index: Dict[str, int] = field(default_factory=dict)
    item_list: List[Item] = field(default_factory=list)
    item_resolve_list: List[ItemResolve] = field(default_factory=list)
    item_draw_list: List[list[RuntimeAction]] = field(default_factory=list)
    pool_id_index: Dict[str, int] = field(default_factory=dict)
    pool_list: List[Pool] = field(default_factory=list)
    # 供engine直接调用的抽卡动作,对每一个池子构建一个DrawPool动作
    pool_draw_list: List[RuntimeAction] = field(default_factory=list)
    draw_stage_id_index: Dict[str, int] = field(default_factory=dict)
    draw_stage_list: List[Stage] = field(default_factory=list)


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

    op: RuntimeOpCode
    conditions: Sequence[RuntimeCondition]
    actions: List[RuntimeAction] | None


@dataclass(frozen=True, slots=True)
class CheckNode(ConditionNode):
    kind: ClassVar[Literal[RuntimeKind.CheckNode]] = RuntimeKind.CheckNode

    item_index: int
    op: RuntimeOpCode
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
    retain: int = 0
    actions: List[RuntimeAction] = field(default_factory=list)


class Reporter:
    class ReportLevel(IntEnum):
        Debug = 0
        Info = 1
        Warning = 2
        Error = 3

    DEFAULT_REPORT_CONFIG = {
        "debug_prefix": "[debug]: ",
        "debug_postfix": "",
        "info_prefix": "[info]: ",
        "info_postfix": "",
        "warning_prefix": "[warning]: ",
        "warning_postfix": "",
        "error_prefix": "[error]: ",
        "error_postfix": "",
    }

    def __init__(
        self,
        *,
        auto_report: bool = True,
        report_level: ReportLevel = ReportLevel.Warning,
        show_report_level: ReportLevel = ReportLevel.Warning,
        fail_report_level: ReportLevel = ReportLevel.Error,
        config: Optional[dict[str, str]] = None,
        max_char_per_line: int = 256,
        stream: Optional[TextIO] = None,
    ):
        self.auto_report = auto_report
        self.report_level = report_level
        self.show_report_level = show_report_level
        self.fail_report_level = fail_report_level
        self.messages = []
        self.config = (
            {
                k: config.get(k, self.DEFAULT_REPORT_CONFIG.get(k))
                for k in self.DEFAULT_REPORT_CONFIG.keys()
            }
            if config is not None
            else self.DEFAULT_REPORT_CONFIG
        )
        self.max_char_per_line = max_char_per_line
        self.stream = stream if stream is not None else sys.stdout

    def log(self, message: str, level: ReportLevel = ReportLevel.Info) -> None:
        self.messages.append((level, message))

    def report(self) -> bool:
        result = False
        for level, message in self.messages:
            if level >= self.show_report_level:
                if level >= self.fail_report_level:
                    result = True
                match level:
                    case self.ReportLevel.Debug:
                        prefix = self.config.get("debug_prefix")
                        postfix = self.config.get("debug_postfix")
                    case self.ReportLevel.Info:
                        prefix = self.config.get("info_prefix")
                        postfix = self.config.get("info_postfix")
                    case self.ReportLevel.Warning:
                        prefix = self.config.get("warning_prefix")
                        postfix = self.config.get("warning_postfix")
                    case self.ReportLevel.Error:
                        prefix = self.config.get("error_prefix")
                        postfix = self.config.get("error_postfix")
                    case _:
                        prefix = postfix = ""
                message = "\n".join(
                    ss[: self.max_char_per_line - 3] + "..."
                    if len(ss) >= self.max_char_per_line
                    else ss
                    for ss in message.split("\n")
                )
                self.stream.write(f"{prefix}{message}{postfix}\n")
        self.messages.clear()
        return result

    def debug(self, message: str) -> None:
        self.log(message, self.report_level.Debug)

    def info(self, message: str) -> None:
        self.log(message, self.report_level.Info)

    def warning(self, message: str) -> None:
        self.log(message, self.report_level.Warning)

    def error(self, message: str) -> None:
        self.log(message, self.report_level.Error)

    def __enter__(self):
        self.messages.clear()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self.auto_report:
            self.report()
        return False
