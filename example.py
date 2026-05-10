from pathlib import Path
from gacha_sim.run.main import (
    load_simulation_result,
    save_simulation_result,
    simulate_until_total_draw,
)
from gacha_sim.core.builder import RuntimeBuilder
from gacha_sim.core.engine import MonteCarlo
from gacha_sim.run.visualize import Visualizer
import os
import numpy as np


def run_save(
    config_name: str,
    termination_name: str,
    target_total_draw: int = 100000000,
    seed: int = 0,
    workers: int = min(
        24,
        os.cpu_count() or 1,
    ),
):
    project_root = Path(__file__).resolve().parent
    base_path = os.path.join(project_root, "configs", config_name)
    config_json_path = os.path.join(base_path, "config.json")
    termination_json_path = os.path.join(base_path, termination_name + ".json")
    result_file_path = (
        f"./data/{config_name}_{termination_name}_{target_total_draw}_seed{seed}.npz"
    )
    name = os.path.basename(os.path.dirname(config_json_path))
    simulate_name = f"{name}_{Path(termination_json_path).stem}"
    builder = RuntimeBuilder(
        config_path=config_json_path, termination_path=termination_json_path
    )

    ctx = builder.build()
    if not Path(result_file_path).exists():
        simulator = MonteCarlo(ctx, seed=seed)
        result = simulate_until_total_draw(
            simulator, target_total_draw=target_total_draw, workers=workers
        )
        data_dir = Path("./data")
        data_dir.mkdir(parents=True, exist_ok=True)
        save_simulation_result(result_file_path, result)
    result = load_simulation_result(result_file_path)
    print("Total runs:", result["total_runs"])
    print("Total draw:", result["total_draw"])
    print("terminate reasons distribution:")
    unique, count = np.unique(result["terminate_reasons"], return_counts=True)
    for reason, count in zip(unique, count):
        print(f"  {reason}: {count}")
    print("Average draw per run:", np.mean(result["draw_count"]))
    print("Lifetime acquired (per item):")
    for item_id, index in ctx.item_id_index.items():
        total_acquired = np.sum(result["lifetime_acquired"][:, index])
        print(f"  {item_id}: {total_acquired}")

    viz = Visualizer(result)
    img_dir = Path("./images")
    img_dir.mkdir(parents=True, exist_ok=True)
    # viz.plot_draw_distribution(
    #     save_path=f"./images/{simulate_name}_draw_distribution.svg"
    # )
    viz.plot_cdf(save_path=f"./images/{simulate_name}_cdf.svg")


if __name__ == "__main__":
    base_seed = int("0721")
    run_save(
        "nezha2_zhenpinchuanshuo",
        "termination_skin",
        target_total_draw=100000000,
        seed=base_seed+1,
    )
    # print(os.cpu_count())
