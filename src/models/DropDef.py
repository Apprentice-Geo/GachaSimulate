from dataclasses import dataclass

@dataclass(frozen=True,slots=True)
class Drop:
    prob: float
    type: str
    id: str
    amount: int

