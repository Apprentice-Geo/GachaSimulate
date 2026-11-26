# Analysis JSON

`gachasimulate-analyze --input <file.gsr>` 向 stdout 写出一个 JSON 对象；诊断信息写入 stderr，失败时返回非零退出码。该对象必须满足 [`analysis.schema.json`](schemas/analysis.schema.json)，且不能包含未知字段。

```json
{
  "result_item": { "id": "draw_count", "name": "抽数" },
  "totals": { "runs": "10000", "result": "15000" },
  "values": ["1", "2"],
  "cumulative": [0.5, 1],
  "statistic": {
    "P5": "1",
    "P25": "1",
    "P50": "1",
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

## 字段与统计口径

- `result_item` 是启动模拟时选定的物品。配置省略展示名称时，`name` 使用物品 ID。
- `totals.runs` 是模拟次数，`totals.result` 是各次模拟中该物品期末库存的总和。次数、库存和整数统计值均写成十进制字符串，除 `"0"` 外没有前导零。
- `values` 按升序列出不同的期末库存。`cumulative[i]` 表示库存小于或等于 `values[i]` 的模拟次数占比。两个数组等长且分别严格递增，最后一个累计占比为 `1`。
- 计算第 `p` 百分位时，将全部 `n` 个观测值从小到大排列，在从零开始的位置 `(n - 1) * p / 100` 做线性插值，结果向零取整。`MEAN` 是向零取整后的算术平均值，`MEAN_LEVEL` 是期末库存小于或等于 `MEAN` 的模拟次数占比。
- `termination_reason[].proportion` 是整数百分比。各原因先取百分比的整数部分，再按余数从大到小分配剩余百分点，余数相同时按原因名称顺序分配。总和为 `100`。

## 读取与校验

紧凑 JSON 正文按 UTF-8 编码最多为 64 MiB。CLI 末尾的一个平台换行（`LF` 或 `CRLF`）不计入上限。

JSON Schema 定义字段、类型和局部取值范围。`validate_analysis` 另外检查两个数组的长度和单调性、最后一个累计占比以及终止原因百分比之和。各统计量由 C++ analyzer 计算，读取端不重新计算。

构建可视化模型时，整数字符串必须能转换为非负的 JavaScript 安全整数。展示字段单独读取，见 [DisplayConfig](DISPLAY_CONFIG.md)。修改格式时同步检查 Schema、校验函数、TypeScript 类型与共享测试数据，验证命令见 [Development Checks](DEVELOPMENT_CHECKS.md)。
