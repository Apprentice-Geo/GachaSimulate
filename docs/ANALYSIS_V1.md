# Analysis JSON v1

`gachasimulate-analyze --input <file.gsr> --metric <draw|cost>` 在 stdout 输出一个 JSON 对象；诊断只写 stderr，失败返回非零。对象必须通过 [`analysis_v1.schema.json`](schemas/analysis_v1.schema.json)，禁止未知字段。

```json
{
  "analysis_version": 1,
  "metric": "draw",
  "totals": { "runs": "4", "draw": "11", "cost": null },
  "values": ["1", "2", "4"],
  "cumulative": [0.25, 0.5, 1.0],
  "statistic": {
    "P5": "1",
    "P25": "1",
    "P50": "3",
    "P75": "4",
    "P95": "4",
    "MIN": "1",
    "MEAN": "2",
    "MEAN_LEVEL": 0.5,
    "MAX": "4"
  },
  "termination_reason": [
    { "reason": "exchange", "proportion": 25 },
    { "reason": "skin", "proportion": 75 }
  ]
}
```

可能来自 GSR `u64` 或 `i64` 的整数均为规范十进制字符串。`totals.cost` 在 GSR 没有 cost section 时为 `null`；选择 `cost` metric 时缺少该 section 会失败。

`values` 严格递增，`cumulative` 严格递增且最后一项为 `1`。percentile 使用 `(n - 1) * p / 100` 线性插值后向零截断；mean 向零截断；`MEAN_LEVEL` 是排序数组中 `<= MEAN` 的比例。termination 按 reason 排序，整数百分比使用最大余数法，同余数按 reason 排序。

TypeScript 适配器在转换为 `VisualizeInput` 前拒绝非规范整数、负数及超过 JavaScript 安全整数范围的值，并继续调用既有可视化输入校验。它只在内存中合并固定展示字段和 GSR 修改时间，不写 sidecar 或修改 GSR。
