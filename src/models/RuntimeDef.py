from dataclasses import dataclass
import numpy as np
from typing import Dict, List, Tuple
from .TerminationDef import ConditionNode,LogicNode

@dataclass(slots=True)
class state:
    items:List[int]
    roll_count:int

@dataclass(frozen=True,slots=True)
class add_item:
    index:int
    amount:int

@dataclass(frozen=True,slots=True)
class reduce_item:
    index:int
    amount:int

@dataclass(frozen=True,slots=True)
class resolve:
    ops:List[add_item | reduce_item]

@dataclass(frozen=True,slots=True)
class pool:
    index:int
    cdf:np.ndarray
    ops:List[add_item]

@dataclass(frozen=True,slots=True)
class milestone:
    roll_count:int
    ops:List[add_item]

@dataclass(frozen=True,slots=True)
class item:
    index:int
    trigger:int | None
    resolve:int | None

@dataclass(frozen=True,slots=True)
class check_node(ConditionNode):
    index: int
    op: str
    value: int
    reason: str

@dataclass(frozen=True,slots=True)
class runtime_context:
    RMB_per_roll:int
    item_id_index:Dict[str,int]
    item_list:List[item]
    resolve_list:List[resolve]
    pool_id_index:Dict[str,int]
    pool_list:List[pool]
    milestone_id_index:Dict[str,int]
    milestone_list:List[milestone]
    Termination_tree: LogicNode

