from __future__ import annotations
from dataclasses import dataclass
import numpy as np
from typing import Dict, List, Tuple
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass(frozen=True,slots=True)
class Runtime_context:
    RMB_per_roll:int
    item_id_index:Dict[str,int]
    item_list:List[Item]
    item_resolve_index:List[int]
    item_resolve_list:List[List[Action]]
    item_draw_list:List[List[Action]]
    pool_id_index:Dict[str,int]
    pool_list:List[Pool]
    draw_stage_id_index:Dict[str,int]
    draw_stage_list:List[List[Action]]
    Termination_tree: LogicNode

class Runtime_state:
    __slots__ = (
        "rng",
        "inventory", # 规则用库存（会被分解）
        "acquired",  # 统计用累计获得
        "reduced",   # 统计用累计消耗
        "draw_count",
        "RMB_cost",
        "terminate",
        "terminate_reason"
    )

    def __init__(self, item_count: int,seed=None):
        self.rng =  np.random.default_rng(seed)
        self.inventory = np.zeros(item_count, dtype=np.int32)
        self.acquired = np.zeros(item_count, dtype=np.int32)
        self.reduced = np.zeros(item_count, dtype=np.int32)
        self.draw_count = 0
        self.RMB_cost = 0
        self.terminate = False
        self.terminate_reason=None

class Action(ABC):

    #abstract method to execute the action, which must be implemented by subclasses
    @abstractmethod
    def execute(self, runtime_state:Runtime_state,runtime_context:Runtime_context):
        pass

@dataclass(frozen=True,slots=True)
class Add_item(Action):
    item_index:int
    amount:int

    def execute(self, runtime_state:Runtime_state,runtime_context:Runtime_context):
        runtime_state.inventory[self.item_index] += self.amount
        runtime_state.acquired[self.item_index] += self.amount

@dataclass(frozen=True,slots=True)
class Reduce_item(Action):
    item_index:int
    amount:int

    def execute(self, runtime_state:Runtime_state,runtime_context:Runtime_context):
        runtime_state.inventory[self.item_index] -= self.amount
        runtime_state.reduced[self.item_index] += self.amount

@dataclass(frozen=True,slots=True)
class Draw_pool(Action):
    pool_index:int
    amount:int

    def execute(self, runtime_state:Runtime_state,runtime_context:Runtime_context):
        r = runtime_state.rng.random()
        idx = np.searchsorted(runtime_context.pool_list[self.pool_index].cdf, r)
        op = runtime_context.pool_list[self.pool_index].actions[idx]
        op.execute(runtime_state, runtime_context)
        
@dataclass(frozen=True,slots=True)
class Termination(Action):
    reason:str

    def execute(self, runtime_state:Runtime_state,runtime_context:Runtime_context):
        runtime_state.terminate = True
        runtime_state.terminate_reason = self.reason

class ConditionNode(ABC): ...

@dataclass(frozen=True,slots=True)
class LogicNode(ConditionNode):
    op: str
    children: Tuple[ConditionNode]
    actions: List[Action] | None

@dataclass(frozen=True,slots=True)
class CheckNode(ConditionNode):
    subject: str
    id: str
    op: str
    value: int
    actions: List[Action] | None

@dataclass(frozen=True,slots=True)
class Pool:
    index:int
    cdf:np.ndarray
    actions:List[Add_item]

@dataclass(frozen=True,slots=True)
class Item:
    id:str
    name:str