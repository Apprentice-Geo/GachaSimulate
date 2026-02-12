from src.Config import config_parser
from src.RuntimeBuild import runtime_builder

if __name__ == "__main__":
    config = config_parser("configs/sunwukong-wuxiang26_1_1_26_2_23_skin.json")
    # print(config.Config_name)
    # print(config.Items_dict)
    # print(config.ItemBehaviors_dict)
    # print(config.Rules_dict)
    # print(config.Milestones_dict)
    # print(config.DropPools)
    print(config.Termination_tree)
    builder = runtime_builder(config)
    runtime_ctx = builder.build()
    # print(runtime_ctx.item_id_index)
    # print(runtime_ctx.item_list)
    # print(runtime_ctx.resolve_list)
    # print(runtime_ctx.pool_id_index)
    # print(runtime_ctx.pool_list)
    # print(runtime_ctx.milestone_id_index)
    # print(runtime_ctx.milestone_list)
    print(runtime_ctx.Termination_tree)
    