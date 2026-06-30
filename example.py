from pathlib import Path
from gachasimulate.core import (
    load_simulation_result,
    simulate_until_total_draw,
)
from gachasimulate.builder import build_from_files
from gachasimulate.engine import MonteCarlo
import os

PROJECT_ROOT = Path(__file__).resolve().parent


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

    base_path = os.path.join(PROJECT_ROOT, "configs", config_name)
    config_yaml_path = os.path.join(base_path, "config.yaml")
    termination_yaml_path = os.path.join(base_path, termination_name + ".yaml")
    result_file_path = f"./data/{config_name}_{termination_name}_{target_total_draw}_seed{seed}.npz"
    # name = os.path.basename(os.path.dirname(config_yaml_path))
    # simulate_name = f"{name}_{Path(termination_yaml_path).stem}"
    ctx = build_from_files(config_yaml_path, termination_yaml_path)
    if not Path(result_file_path).exists():
        simulator = MonteCarlo(ctx, seed=seed)
        result = simulate_until_total_draw(
            simulator, target_total_draw=target_total_draw, workers=workers
        )
        # data_dir = Path("./data")
        # data_dir.mkdir(parents=True, exist_ok=True)
        # save_simulation_result(result_file_path, result)
        # save_visualize_input(f"./data/{simulate_name}_visualize_input.json", result)
        # save_simulation_result(result_file_path, result)
        # save_visualize_input(f"./data/{simulate_name}_visualize_input.json", result)
    else:
        result = load_simulation_result(result_file_path)

    # print("Total runs:", result["total_runs"])
    # print("Total draw:", result["total_draw"])
    # print("terminate reasons distribution:")
    # unique, count = np.unique(result["terminate_reasons"], return_counts=True)
    # for reason, count in zip(unique, count):
    #     print(f"  {reason}: {count}")
    # print("Average draw per run:", np.mean(result["draw_count"]))
    # print("Lifetime acquired (per item):")
    # for item_id, index in ctx.item_id_index.items():
    #     total_acquired = np.sum(result["lifetime_acquired"][:, index])
    #     print(f"  {item_id}: {total_acquired}")

    # viz = Visualizer(result)
    # img_dir = Path("./images")
    # img_dir.mkdir(parents=True, exist_ok=True)
    # viz = Visualizer(result)
    # img_dir = Path("./images")
    # img_dir.mkdir(parents=True, exist_ok=True)
    # viz.plot_draw_distribution(
    #     save_path=f"./images/{simulate_name}_draw_distribution.svg"
    # )
    # viz.plot_cdf(save_path=f"./images/{simulate_name}_cdf.svg")
    # viz.plot_cdf(save_path=f"./images/{simulate_name}_cdf.svg")


if __name__ == "__main__":
    base_seed = int("666")
    run_save(
        "sanliou_zhenpinchuanshuo",
        "termination_skin",
        target_total_draw=1000000,
        seed=base_seed,
        workers=1,
    )
    # print(os.cpu_count())
