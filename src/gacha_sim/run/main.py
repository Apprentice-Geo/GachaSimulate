from gacha_sim.core.builder import runtime_builder
from gacha_sim.core.engine import montecarlo
import numpy as np
import hashlib
from datetime import datetime
import json
from tqdm import tqdm

def simulate_until_total_draw(sim: montecarlo, target_total_draw: int):
    """
    持续运行完整模拟，直到累计抽数达到目标值
    """

    draw_count = []
    rmb_cost = []
    acquired_records = []
    terminate_reasons = []

    total_rmb_cost = 0
    total_draw = 0
    total_runs = 0

    with tqdm(total=target_total_draw, desc="Simulating", unit="draw") as pbar:

        while total_draw < target_total_draw:
            state = sim.run_once()

            draw_count.append(state.draw_count)
            rmb_cost.append(state.rmb_cost)
            acquired_records.append(state.acquired.copy())
            terminate_reasons.append(state.terminate_reason)

            total_rmb_cost += state.rmb_cost
            total_draw += state.draw_count
            total_runs += 1

            # 更新进度条（按实际增加的抽数）
            pbar.update(state.draw_count)

            # 防止超过总量导致进度条溢出
            if total_draw > target_total_draw:
                pbar.update(target_total_draw - pbar.n)

    return {
        "seed": sim.seed,
        "draw_count": np.asarray(draw_count, dtype=np.int32),
        "rmb_cost": np.asarray(rmb_cost, dtype=np.int32),
        "lifetime_acquired": np.vstack(acquired_records).astype(np.int32),
        "terminate_reasons": np.array(terminate_reasons, dtype="U32"),
        "rmb_cost_total": np.int64(total_rmb_cost),
        "total_draw": np.int64(total_draw),
        "total_runs": np.int32(total_runs),
    }


def save_simulation_result(path: str, result: dict):
        
        np.savez_compressed(
        path,
        draw_count=result["draw_count"],
        rmb_cost=result["rmb_cost"],
        lifetime_acquired=result["lifetime_acquired"],
        terminate_reasons=result["terminate_reasons"],
        rmb_cost_total=result["rmb_cost_total"],
        total_draw=result["total_draw"],
        total_runs=result["total_runs"],
        has_seed=result["seed"] is not None,
        seed=0 if result["seed"] is None else int(result["seed"]),
        timestamp=str(datetime.now())
    )

def load_simulation_result(path: str):
    data = np.load(path, allow_pickle=False)

    return {
        "draw_count": data["draw_count"],
        "rmb_cost": data["rmb_cost"],
        "lifetime_acquired": data["lifetime_acquired"],
        "terminate_reasons": data["terminate_reasons"],
        "rmb_cost_total": int(data["rmb_cost_total"]),
        "total_draw": int(data["total_draw"]),
        "total_runs": int(data["total_runs"]),
        "has_seed": bool(data["has_seed"]),
        "seed": int(data["seed"]) if data["has_seed"] else None,
        "timestamp": str(data["timestamp"])
    }