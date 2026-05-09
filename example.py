from pathlib import Path
from gacha_sim.run.main import (
    load_simulation_result,
    save_simulation_result,
    simulate_until_total_draw,
)
from gacha_sim.core.builder import runtime_builder
from gacha_sim.core.engine import montecarlo
from gacha_sim.run.visualize import Visualizer
import os
import numpy as np


def run_save(
    CONFIG_NAME: str,
    TERMINATION_NAME: str,
    TARGET_TOTAL_DRAW: int = 100000000,
    SEED: int = 0,
    WORKERS: int = min(
        24,
        os.cpu_count() or 1,
    ),
):
    project_root = Path(__file__).resolve().parent
    BASE_PATH = os.path.join(project_root, "configs", CONFIG_NAME)
    CONFIG_JSON_PATH = os.path.join(BASE_PATH, "config.json")
    TERMINATION_JSON_PATH = os.path.join(BASE_PATH, TERMINATION_NAME + ".json")
    RESULT_FILE_PATH = (
        f"./data/{CONFIG_NAME}_{TERMINATION_NAME}_{TARGET_TOTAL_DRAW}_seed{SEED}.npz"
    )
    name = os.path.basename(os.path.dirname(CONFIG_JSON_PATH))
    simulate_name = f"{name}_{Path(TERMINATION_JSON_PATH).stem}"
    builder = runtime_builder(
        config_path=CONFIG_JSON_PATH, termination_path=TERMINATION_JSON_PATH
    )

    ctx = builder.build()
    if not Path(RESULT_FILE_PATH).exists():
        simulator = montecarlo(ctx, seed=SEED)
        result = simulate_until_total_draw(
            simulator, target_total_draw=TARGET_TOTAL_DRAW, workers=WORKERS
        )
        data_dir = Path("./data")
        data_dir.mkdir(parents=True, exist_ok=True)
        save_simulation_result(RESULT_FILE_PATH, result)
    result = load_simulation_result(RESULT_FILE_PATH)
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
    BASE_SEED = int("0721")
    run_save(
        "lixin_wenxinjian",
        "termination_skin",
        TARGET_TOTAL_DRAW=20000000,
        SEED=BASE_SEED,
    )
    # print(os.cpu_count())
