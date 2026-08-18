import input from "../visualize/fixtures/example_input.json";
import type { ResultEditorState } from "../shared/result_editor";
import type {
  ConfigRepositoryState,
  InstalledConfig,
} from "../shared/installed_config";
import type { VisualizeInput } from "../visualize/types/visualize_input";
import type { AnalysisV2 } from "../visualize/types/analysis";

export function result_fixture(): ResultEditorState {
  const fixture = input as VisualizeInput;
  return {
    path: "/tmp/example.gsr",
    filename: "example.gsr",
    fields: {
      title: fixture.title,
      target: fixture.target,
      result_item_name: fixture.result_item.name,
      note: fixture.note,
      price: fixture.price,
      unit: fixture.unit,
    },
    analysis: {
      analysis_version: 2,
      result_item: fixture.result_item,
      totals: { runs: String(fixture.runs), result: String(fixture.total) },
      values: fixture.values.map(String),
      cumulative: fixture.cumulative,
      statistic: Object.fromEntries(
        Object.entries(fixture.statistic).map(([key, value]) => [
          key,
          String(value),
        ]),
      ) as unknown as AnalysisV2["statistic"],
      termination_reason: fixture.termination_reason,
    },
    display: {
      display_version: 1,
      title: fixture.title,
      target: fixture.target,
      result_item_name: fixture.result_item.name,
      note: fixture.note,
      price: fixture.price,
      unit: fixture.unit,
    },
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
