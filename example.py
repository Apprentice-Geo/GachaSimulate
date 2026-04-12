from pathlib import Path
from gacha_sim.run.main import (
    load_simulation_result,
    save_simulation_result,
    simulate_until_total_draw,
)
from gacha_sim.core.builder import runtime_builder
from gacha_sim.core.engine import montecarlo
from gacha_sim.run.Visualize import Visualizer
import os
import numpy as np

if __name__ == "__main__":
    project_root = Path(__file__).resolve().parent
    BASE_PATH = os.path.join(project_root, "configs", "lixin_wenxinjian")
    CONFIG_JSON_PATH = BASE_PATH + "/config.json"
    TERMINATION_JSON_PATH = BASE_PATH + "/termination_skin.json"
    name = os.path.basename(os.path.dirname(CONFIG_JSON_PATH))
    simulate_name = f"{name}_{Path(TERMINATION_JSON_PATH).stem}"
    builder = runtime_builder(
        config_path=CONFIG_JSON_PATH, termination_path=TERMINATION_JSON_PATH
    )
    
    ctx = builder.build()
   
    simulator = montecarlo(ctx, seed=0)
    result = simulate_until_total_draw(simulator, target_total_draw=1000000)
    data_dir = Path("./data")
    data_dir.mkdir(parents=True, exist_ok=True)
    save_simulation_result(
        "./data/" + simulate_name + "_simulation_result.npz", result, ctx
    )
    result = load_simulation_result(
        "./data/" + simulate_name + "_simulation_result.npz"
    )
    print("Total runs:", result["total_runs"])
    print("Total draw:", result["total_draw"])
    print("rmb cost total:", result["rmb_cost_total"])
    print("terminate reasons distribution:")
    unique, count = np.unique(result["terminate_reasons"], return_counts=True)
    for reason, count in zip(unique, count):
        print(f"  {reason}: {count}")
    print("Average draw per run:", np.mean(result["draw_count"]))
    print("Average rmb cost per run:", np.mean(result["rmb_cost"]))
    print("Lifetime acquired (per item):")
    for item_id, index in ctx.item_id_index.items():
        total_acquired = np.sum(result["lifetime_acquired"][:, index])
        print(f"  {item_id}: {total_acquired}")

    viz = Visualizer(result)
    img_dir = Path("./images")
    img_dir.mkdir(parents=True, exist_ok=True)
    viz.plot_draw_distribution(
        save_path=f"./images/{simulate_name}_draw_distribution.png"
    )
    viz.plot_cdf(save_path=f"./images/{simulate_name}_cdf.png")
