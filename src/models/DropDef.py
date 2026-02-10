from dataclasses import dataclass
from typing import List

@dataclass(frozen=True)
class Drop:
    prob: float
    type: str
    id: str
    amount: int

@dataclass(frozen=True)
class Pool:
    drops:List[Drop]
    cdf: List[float]
