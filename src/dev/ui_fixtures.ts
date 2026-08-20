import analysis from "../visualize/fixtures/example_analysis.json";
import display from "../visualize/fixtures/example_display.json";
import type { ResultEditorState } from "../shared/result_editor";
import type { InstalledConfig } from "../shared/installed_config";
import type { AnalysisV2 } from "../visualize/types/analysis";
import type { DisplayConfig } from "../visualize/types/display_config";

export function result_fixture(): ResultEditorState {
  const analysis_fixture = analysis as AnalysisV2;
  const display_fixture = display as DisplayConfig;
  return {
    path: "/tmp/example.gsr",
    filename: "example.gsr",
    fields: {
      title: display_fixture.title,
      target: display_fixture.target,
      result_item_name: display_fixture.result_item_name,
      note: display_fixture.note,
      price: display_fixture.price,
      unit: display_fixture.unit,
    },
    analysis: analysis_fixture,
    display: display_fixture,
    sidecar_path: "/tmp/example.visualize.json",
  };
}

export function simulation_fixture(): InstalledConfig[] {
  const names = [
    ["draw_count", "抽数"],
    ["target", "目标角色"],
    ["miss", "未命中"],
    ["featured_character", "限定角色"],
    ["standard_character", "常驻角色"],
    ["featured_weapon", "限定武器"],
    ["standard_weapon", "常驻武器"],
    ["guarantee_count", "保底计数"],
    ["pity_count", "当前水位"],
    ["spark_point", "兑换点数"],
    ["token", "商店代币"],
    ["bonus_item", "额外物品"],
    ["rare_item", "稀有物品"],
    ["common_item", "普通物品"],
    ["path_point", "定轨点数"],
    ["exchange_count", "兑换次数"],
    ["duplicate_count", "重复获取"],
    ["total_reward", "奖励总数"],
  ] as const;
  return [
    {
      id: "instrument_fixture",
      name: "概率仪器台验收配置",
      description: "包含长统计物品列表，用于检查搜索、选择和滚动区域。",
      source: "installed",
      terminations: [
        { file: "target.yaml", name: "获得目标物品" },
        { file: "budget.yaml", name: "达到预算上限" },
      ],
      items: names.map(([id, name]) => ({ id, name })),
    },
  ];
}
