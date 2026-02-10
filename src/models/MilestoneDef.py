from dataclasses import dataclass

@dataclass(frozen=True)
class Milestone:
    type: str
    roll_count: int
    reward:Reward

@dataclass(frozen=True)
class Reward:
    type: str
    id: str
    amount: int