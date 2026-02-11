from dataclasses import dataclass
from typing import Optional,Any

@dataclass(frozen=True,slots=True)
class Trigger:
    type:str
    rule:Any

@dataclass(frozen=True,slots=True)
class Resolve:
    type: str
    id: str
    amount: int

@dataclass(frozen=True,slots=True)
class Item:
    id: str
    name: str
    behavior: ItemBehavior

@dataclass(frozen=True,slots=True)
class ItemBehavior:
    trigger_rule: Optional[Trigger]
    resolve_result: Optional[Resolve]