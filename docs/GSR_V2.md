# GSR v2

GSR 是 little-endian 二进制结果交换格式。GSR v2 为每个固定模拟 run 保存本次模拟所选 result item 的期末库存。

固定 header 为 96 bytes：

| Offset | 字段 |
| -----: | --- |
| 0 | `char[4]` magic：`GSR\0` |
| 4 | `u32` version：`2` |
| 8 | `u32` header size：`96` |
| 12 | `u32` flags：`0` |
| 16 | `u64` total runs |
| 24 | `u64` total result |
| 32 | `i64` seed |
| 40 | `u32` reason count |
| 44 | `u32` result ID byte length |
| 48 | `u32` result name byte length |
| 52 | `u32` reserved：`0` |
| 56 | `u64` result offset：`96` |
| 64 | `u64` reason offset |
| 72 | `u64` string-table offset |
| 80 | `u64` file size |
| 88 | `u64` reserved：`0` |

各 section 按以下顺序排列：

1. `u64[total_runs]` result values；
2. `u32[total_runs]` termination reason indexes；
3. UTF-8 result item ID；
4. UTF-8 result item display name；
5. `reason_count` 个 reason strings，每项编码为 `u32` byte length，随后是 UTF-8 bytes。

`result_offset` 固定为 96；`reason_offset` 紧跟 result array，`string_offset` 紧跟 reason array。`total_result` 必须等于所有 result values 经过溢出检查后的 `u64` 总和。reason index 引用按名称排序、去重后的 reason string table。

reader 和 writer 拒绝超过 16 GiB 的文件、超过 1,000,000,007 个 run、超过 65,536 个 reason、空字符串或超过 1 MiB 的字符串、非法 UTF-8、非法 offset、trailing data 和算术溢出。旧 header 以及独立 metric/cost section 均会被拒绝；本仓库没有旧格式 reader 或兼容路径。

分析输出契约见 [Analysis JSON v2](ANALYSIS_V2.md)。
