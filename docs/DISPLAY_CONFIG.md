# DisplayConfig

DisplayConfig v2 是 GSR 对应的独立展示配置，以 `<stem>.visualize.json` sidecar 保存。它与 [Analysis](ANALYSIS.md) 共同构成 Electron 结果展示和素材导出的唯一输入契约。

## 结构与字段职责

对象必须满足 [`display_config.schema.json`](schemas/display_config.schema.json)。所有字段均必填，不允许未知字段：

```json
{
  "display_version": 2,
  "title": "模拟结果分布",
  "target": "获得目标物品",
  "result_item_name": "抽数",
  "note": "示例说明",
  "subtitle": "",
  "result_item_unit": "抽"
}
```

| 字段 | 约束与用途 |
| --- | --- |
| `display_version` | 固定为整数 `2` |
| `title` | 字符串，画面主标题 |
| `target` | 字符串，目标说明；不修改模拟目标或规则 |
| `result_item_name` | 非空字符串，控制结果物品的展示名称，不修改 item ID |
| `note` | 字符串，画面说明 |
| `subtitle` | 字符串，主标题下的副标题；空字符串表示不展示副标题 |
| `result_item_unit` | 字符串，累计结果和统计指标展示值的单位；空字符串表示不追加单位 |

除 `result_item_name` 外，字符串字段允许为空。CDF 坐标轴标题与刻度保持无单位，具体展示原则见 [Visualization Design](VISUALIZATION_DESIGN.md#数据表达与文案)。

## 数据来源与保存

`result_item.id`、`totals.result`、`totals.runs`、CDF、统计指标和终止原因来自 GSR 经 analyzer 生成的 Analysis，不能由 DisplayConfig 覆盖。`result_item_name` 只控制展示名称，单位和说明也不参与统计计算。

Electron 的结果编辑页与结果可视化页共享当前 GSR 会话。main 调用 C++ analyzer 并校验 Analysis；编辑页的六个展示字段在失焦时原子保存到 sidecar。重新打开结果时只从 sidecar 恢复展示配置，分析数据从 GSR 重新获取。非法 sidecar 不被自动覆盖。

DisplayConfig sidecar 使用独立的 16 MiB 大小上限。视图模型只在内存中合并已校验的 `Analysis + DisplayConfig`，不将 Analysis 写入 sidecar，也不修改 GSR。

## 校验与兼容边界

JSON Schema 是字段、类型、必填项和局部取值约束的权威。`validate_display_config` 当前只执行对应 Schema，没有额外语义规则；TypeScript 类型是消费方的静态视图，不独立定义格式。

DisplayConfig v1、旧完整 JSON 和旧字段均按非法配置拒绝，不做隐式兼容、迁移或自动改写。需要兼容时，应明确修改契约与迁移策略。

修改输入结构时，同步更新 Schema、TypeScript 类型、共享 fixture 和相关测试；只有新增 Schema 无法表达的语义约束时，才扩展 semantic validator，不重复实现 Schema 约束。结果会话和共享视图模型边界见 [Architecture](../ARCHITECTURE.md#可视化与导出)，检查范围见 [Development Checks](DEVELOPMENT_CHECKS.md)。
