from __future__ import annotations
from dataclasses import dataclass
from typing import Tuple

class ConditionNode: ...

@dataclass(frozen=True,slots=True)
class LogicNode(ConditionNode):
    op: str
    children: Tuple[ConditionNode, ...]

@dataclass(frozen=True,slots=True)
class CheckNode(ConditionNode):
    subject: str
    id: str
    op: str
    value: int
    reason: str