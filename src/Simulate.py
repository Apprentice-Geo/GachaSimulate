from .Config import config_parser
from .RuntimeBuild import runtime_builder
from .MonteCarlo import montecarlo, runtime_state
from .models.RuntimeDef import runtime_context
import numpy as np
import hashlib
from datetime import datetime
import json
from tqdm import tqdm

def simulate_until_total_rolls(sim: montecarlo, target_total_rolls: int):
    """
    持续运行完整模拟，直到累计抽数达到目标值
    """

    roll_counts = []
    RMB_costs = []
    lifetime_records = []
    terminate_reasons = []

    total_RMB_cost = 0
    total_rolls = 0
    total_runs = 0

    with tqdm(total=target_total_rolls, desc="Simulating", unit="roll") as pbar:

        while total_rolls < target_total_rolls:
            state = sim.run_once()

            roll_counts.append(state.roll_count)
            RMB_costs.append(state.RMB_cost)
            lifetime_records.append(state.lifetime_acquired.copy())
            terminate_reasons.append(state.terminate_reason)

            total_RMB_cost += state.RMB_cost
            total_rolls += state.roll_count
            total_runs += 1

            # 更新进度条（按实际增加的抽数）
            pbar.update(state.roll_count)

            # 防止超过总量导致进度条溢出
            if total_rolls > target_total_rolls:
                pbar.update(target_total_rolls - pbar.n)

    return {
        "seed": sim.seed,
        "roll_counts": np.asarray(roll_counts, dtype=np.int32),
        "RMB_costs": np.asarray(RMB_costs, dtype=np.int32),
        "lifetime_acquired": np.vstack(lifetime_records).astype(np.int32),
        "terminate_reasons": np.array(terminate_reasons, dtype="U32"),
        "RMB_cost_total": np.int64(total_RMB_cost),
        "total_rolls": np.int64(total_rolls),
        "total_runs": np.int32(total_runs),
    }


def save_simulation_result(path: str, result: dict, ctx):
    
    # 规则签名（简易 hash）
    ctx_signature = hashlib.md5(
        json.dumps(str(ctx), sort_keys=True).encode()
    ).hexdigest()

    np.savez_compressed(
        path,
        roll_counts=result["roll_counts"],
        RMB_costs=result["RMB_costs"],
        lifetime_acquired=result["lifetime_acquired"],
        terminate_reasons=result["terminate_reasons"],
        RMB_cost_total=result["RMB_cost_total"],
        total_rolls=result["total_rolls"],
        total_runs=result["total_runs"],
        seed=-1 if result["seed"] is None else result["seed"],
        ctx_signature=ctx_signature,
        timestamp=str(datetime.now())
    )

def load_simulation_result(path: str):
    data = np.load(path, allow_pickle=False)

    return {
        "roll_counts": data["roll_counts"],
        "RMB_costs": data["RMB_costs"],
        "lifetime_acquired": data["lifetime_acquired"],
        "terminate_reasons": data["terminate_reasons"],
        "RMB_cost_total": int(data["RMB_cost_total"]),
        "total_rolls": int(data["total_rolls"]),
        "total_runs": int(data["total_runs"]),
        "seed": int(data["seed"]),
        "ctx_signature": str(data["ctx_signature"]),
        "timestamp": str(data["timestamp"]),
    }