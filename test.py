from pathlib import Path
from src.Simulate import load_simulation_result, save_simulation_result, simulate_until_total_rolls
from src.Config import config_parser
from src.RuntimeBuild import runtime_builder
from src.MonteCarlo import montecarlo
import numpy as np

if __name__ == "__main__":
    JSON_PATH="configs/sunwukong-wuxiang26_1_1_26_2_23_skin.json"
    config = config_parser(JSON_PATH)
    # print(config.Config_name)
    # print(config.Items_dict)
    # print(config.ItemBehaviors_dict)
    # print(config.Rules_dict)
    # print(config.Milestones_dict)
    # print(config.DropPools)
    # print(config.Termination_tree)
    builder = runtime_builder(config)
    runtime_ctx = builder.build()
    # print(runtime_ctx.item_id_index)
    # print(runtime_ctx.item_id_name)
    # print(runtime_ctx.item_list)
    # print(runtime_ctx.resolve_list)
    # print(runtime_ctx.pool_id_index)
    # print(runtime_ctx.pool_list)
    # print(runtime_ctx.milestone_id_index)
    # print(runtime_ctx.milestone_list)
    # print(runtime_ctx.Termination_tree)
    # simulator = montecarlo(runtime_ctx,seed=2026212)
    # result = simulate_until_total_rolls(simulator, target_total_rolls=100000)

    result=load_simulation_result("./data/" + Path(JSON_PATH).stem + "_simulation_result.npz")
    print("Total runs:", result["total_runs"])
    print("Total rolls:", result["total_rolls"])
    print("RMB cost total:", result["RMB_cost_total"])
    print("terminate reasons distribution:")
    unique, counts = np.unique(result["terminate_reasons"], return_counts=True)
    for reason, count in zip(unique, counts):
        print(f"  {reason}: {count}")
    print("Average rolls per run:", np.mean(result["roll_counts"]))
    print("Average RMB cost per run:", np.mean(result["RMB_costs"]))
    print("Lifetime acquired (per item):")
    for item_id, index in runtime_ctx.item_id_index.items():
        total_acquired = np.sum(result["lifetime_acquired"][:, index])
        print(f"  {item_id}: {total_acquired}") 
    