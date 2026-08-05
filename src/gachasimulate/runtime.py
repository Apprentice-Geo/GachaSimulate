from __future__ import annotations

import sys
from abc import ABC, abstractmethod
from bisect import bisect_left
from dataclasses import dataclass, field
from typing import ClassVar, Literal, Optional, TextIO
from enum import IntEnum, Enum, auto
import numpy as np

EMPTY_ACTIONS: tuple[()] = ()

type RuntimeCondition = LogicNode | CheckNode
type RuleMode = Literal["once", "per_draw", "repeat"]
type RuntimeAction = AddItem | ReduceItem | SetItem | DrawPool | PoolChange | Termination


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


# build 期使用的可变上下文
@dataclass(frozen=False, slots=True)
class RuntimeBuildingContext:
    initial_actions: list[RuntimeAction] = field(default_factory=list)
    every_draw_actions: list[RuntimeAction] = field(default_factory=list)
    item_id_index: dict[str, int] = field(default_factory=dict)
    item_list: list[Item] = field(default_factory=list)
    item_resolve_list: list[ItemResolve] = field(default_factory=list)
    pool_id_index: dict[str, int] = field(default_factory=dict)
    pool_list: list[Pool] = field(default_factory=list)
    # 供engine直接调用的抽卡动作,对每一个池子构建一个DrawPool动作
    pool_draw_list: list[RuntimeAction] = field(default_factory=list)
    rule_id_index: dict[str, int] = field(default_factory=dict)
    rule_list: list[Rule] = field(default_factory=list)


# 运行时使用的不可变上下文
@dataclass(frozen=True, slots=True)
class RuntimeContext:
    initial_actions: tuple[RuntimeAction, ...]
    every_draw_actions: tuple[RuntimeAction, ...]
    item_id_index: dict[str, int]  # 对物品进行编号
    draw_count_index: int
    item_list: tuple[Item, ...]
    # 分解某个物品时执行的动作
    item_resolve_list: tuple[ItemResolve, ...]
    pool_id_index: dict[str, int]
    pool_list: tuple[Pool, ...]
    # 对每一个池子构建一个 DrawPool 动作
    pool_draw_list: tuple[RuntimeAction, ...]
    rule_id_index: dict[str, int]  # 对规则进行编号
    rule_list: tuple[Rule, ...]
    termination_tree: RuntimeCondition
    cost_index: int | None = None


class RuntimeState:
    __slots__ = (
        "rng",
        "main_pool_index",
        "rule_execute",
        "active_rule_indices",
        "inventory",  # 规则用库存
        "acquired",  # 统计用累计获得
        "reduced",  # 统计用累计消耗
        "terminate",
        "terminate_reason",
    )

    def __init__(self, item_count: int, rng: np.random.Generator):
        self.rng = rng
        self.main_pool_index = 0
        self.rule_execute = []
        self.active_rule_indices = []
        self.inventory = [0] * item_count
        self.acquired = [0] * item_count
        self.reduced = [0] * item_count
        self.terminate = False
        self.terminate_reason: str | None = None


class Action(ABC):
    kind: ClassVar[RuntimeKind] = RuntimeKind.Action

    @abstractmethod
    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        pass


@dataclass(frozen=True, slots=True)
class AddItem(Action):
    kind: ClassVar[Literal[RuntimeKind.AddItem]] = RuntimeKind.AddItem

    item_index: int
    amount: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        runtime_state.inventory[self.item_index] += self.amount
        runtime_state.acquired[self.item_index] += self.amount
        # 将可分解的立即分解
        if runtime_context.item_resolve_list[self.item_index].actions:
            return runtime_context.item_resolve_list[self.item_index].actions * (
                (
                    runtime_state.inventory[self.item_index]
                    - runtime_context.item_resolve_list[self.item_index].retain
                )
                // runtime_context.item_resolve_list[self.item_index].reduce
            )
        else:
            return EMPTY_ACTIONS


@dataclass(frozen=True, slots=True)
class ReduceItem(Action):
    kind: ClassVar[Literal[RuntimeKind.ReduceItem]] = RuntimeKind.ReduceItem

    item_index: int
    amount: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        runtime_state.inventory[self.item_index] -= self.amount
        runtime_state.reduced[self.item_index] += self.amount

        return EMPTY_ACTIONS


@dataclass(frozen=True, slots=True)
class SetItem(Action):
    kind: ClassVar[Literal[RuntimeKind.SetItem]] = RuntimeKind.SetItem

    item_index: int
    amount: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        # 统计 set 导致的增减变更
        runtime_state.acquired[self.item_index] += max(
            0, self.amount - runtime_state.inventory[self.item_index]
        )
        runtime_state.reduced[self.item_index] += max(
            0, runtime_state.inventory[self.item_index] - self.amount
        )
        runtime_state.inventory[self.item_index] = self.amount
        return EMPTY_ACTIONS


@dataclass(frozen=True, slots=True)
class DrawPool(Action):
    kind: ClassVar[Literal[RuntimeKind.DrawPool]] = RuntimeKind.DrawPool

    pool_index: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        r = runtime_state.rng.random()
        # 此处使用 bisect_left 比 np.searchsorted 更快
        idx = bisect_left(runtime_context.pool_list[self.pool_index].cdf, r)
        return runtime_context.pool_list[self.pool_index].actions[idx]


@dataclass(frozen=True, slots=True)
class PoolChange(Action):
    kind: ClassVar[Literal[RuntimeKind.PoolChange]] = RuntimeKind.PoolChange

    pool_index: int

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        runtime_state.main_pool_index = self.pool_index
        return EMPTY_ACTIONS


@dataclass(frozen=True, slots=True)
class Termination(Action):
    kind: ClassVar[Literal[RuntimeKind.Termination]] = RuntimeKind.Termination

    reason: str

    def execute(
        self, runtime_state: RuntimeState, runtime_context: RuntimeContext
    ) -> tuple[RuntimeAction, ...]:
        runtime_state.terminate = True
        runtime_state.terminate_reason = self.reason
        return EMPTY_ACTIONS


class ConditionNode(ABC):
    kind: ClassVar[RuntimeKind] = RuntimeKind.ConditionNode


@dataclass(frozen=True, slots=True)
class LogicNode(ConditionNode):
    kind: ClassVar[Literal[RuntimeKind.LogicNode]] = RuntimeKind.LogicNode

    op: RuntimeOpCode
    children: tuple[RuntimeCondition, ...]
    actions: tuple[RuntimeAction, ...]


@dataclass(frozen=True, slots=True)
class CheckNode(ConditionNode):
    kind: ClassVar[Literal[RuntimeKind.CheckNode]] = RuntimeKind.CheckNode

    item_index: int
    op: RuntimeOpCode
    value: int
    actions: tuple[RuntimeAction, ...]


@dataclass(frozen=True, slots=True, init=False)
class Rule:
    mode: RuleMode
    condition: RuntimeCondition

    def __init__(
        self,
        condition: RuntimeCondition,
        mode: RuleMode | None = None,
        once: bool | None = None,
    ) -> None:
        if mode is None:
            mode = "once" if once is not False else "per_draw"
        object.__setattr__(self, "mode", mode)
        object.__setattr__(self, "condition", condition)

    @property
    def once(self) -> bool:
        return self.mode == "once"


@dataclass(frozen=True, slots=True)
class Pool:
    cdf: tuple[float, ...]
    actions: tuple[tuple[RuntimeAction, ...], ...]


@dataclass(frozen=True, slots=True)
class Item:
    id: str
    name: str


@dataclass(frozen=True, slots=True)
class ItemResolve:
    retain: int = 0
    actions: tuple[RuntimeAction, ...] = EMPTY_ACTIONS
    # 表示 reduce 不参与构造参数
    reduce: int = field(init=False)

    def __post_init__(self) -> None:
        reduce_value = self._get_reduce_from_actions(self.actions)
        # 使用 __setattr__ 绕过 frozen=True 的普通赋值限制，只用于初始化阶段
        object.__setattr__(self, "reduce", reduce_value)

    @staticmethod
    def _get_reduce_from_actions(actions: tuple[RuntimeAction, ...]) -> int:
        for action in actions:
            if action.kind == RuntimeKind.ReduceItem:
                return action.amount
        return 1


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
