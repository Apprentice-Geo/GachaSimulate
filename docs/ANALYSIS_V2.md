# Analysis JSON v2

`gachasimulate-analyze --input <file.gsr>` 向 stdout 写出一个 JSON 对象；诊断信息写入 stderr，失败时返回非零退出码。该对象必须满足 [`analysis_v2.schema.json`](schemas/analysis_v2.schema.json)，且不能包含未知字段。

```json
{
  "analysis_version": 2,
  "result_item": { "id": "draw_count", "name": "抽数" },
  "totals": { "runs": "10000", "result": "123456" },
  "values": ["1", "2"],
  "cumulative": [0.5, 1],
  "statistic": {
    "P5": "1",
    "P25": "1",
    "P50": "2",
    "P75": "2",
    "P95": "2",
    "MIN": "1",
    "MEAN": "1",
    "MEAN_LEVEL": 0.5,
    "MAX": "2"
  },
  "termination_reason": [{ "reason": "done", "proportion": 100 }]
}
```

result item 在模拟启动时选择，Compiler 将其 item index 写入 IR；未提供展示名称时使用 item ID。所有整数值字段都使用 canonical decimal string。`values` 是排序后严格递增的不同期末 result item 值；`cumulative` 给出各值对应的 CDF，最后一项为 `1`。`totals.result` 是所有 run 的 result value 总和。

percentile、mean、CDF 和 termination reason 算法沿用上一版分析实现：percentile 使用 `(n - 1) * p / 100` 线性插值并向零截断；mean 向零截断；`MEAN_LEVEL` 是排序后 observation 中 `<= MEAN` 的比例；整数 termination percentage 使用 largest-remainder method，并以 reason name 顺序作为 tie-breaker。

JSON Schema 是字段、类型、必填项和局部取值约束的权威。TypeScript `validate_analysis` adapter 在执行 Schema 后继续检查跨字段不变量：`values` 与 `cumulative` 等长并分别严格递增、CDF 最后一项为 `1`、termination proportion 总和为 `100`。TypeScript 类型只是消费方的静态视图，不独立定义格式。

validator 不重新计算 `totals.result`、statistic 或 CDF 来验证它们之间的数学关系；这些输出算法由 C++ analyzer 及其行为测试保证。

view-model 构建会将 canonical integer 转换为 JavaScript safe integer，拒绝负数或超出范围的值，并在内存中合并经过独立校验的 DisplayConfig；该过程不会写入 sidecar 或修改 GSR。
