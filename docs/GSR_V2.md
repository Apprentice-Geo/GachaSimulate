# GSR v2

GSR is a little-endian binary result interchange format. GSR v2 stores the
期末库存 of one simulation-selected result item for every fixed simulation run.

The fixed header is 96 bytes:

| Offset | Field |
| -----: | ----- |
| 0 | `char[4]` magic: `GSR\0` |
| 4 | `u32` version: `2` |
| 8 | `u32` header size: `96` |
| 12 | `u32` flags: `0` |
| 16 | `u64` total runs |
| 24 | `u64` total result |
| 32 | `i64` seed |
| 40 | `u32` reason count |
| 44 | `u32` result ID byte length |
| 48 | `u32` result name byte length |
| 52 | `u32` reserved: `0` |
| 56 | `u64` result offset: `96` |
| 64 | `u64` reason offset |
| 72 | `u64` string-table offset |
| 80 | `u64` file size |
| 88 | `u64` reserved: `0` |

Sections appear in this order:

1. `u64[total_runs]` result values;
2. `u32[total_runs]` termination-reason indexes;
3. the UTF-8 result item ID;
4. the UTF-8 result item display name;
5. `reason_count` reason strings, each encoded as `u32` byte length followed
   by UTF-8 bytes.

`result_offset` is always 96; `reason_offset` follows the result array and
`string_offset` follows the reason array. `total_result` must equal the
checked `u64` sum of all result values. Reason indexes refer to the sorted,
deduplicated reason string table.

Readers and writers reject files above 4 GiB, more than 500,000,000 runs,
more than 65,536 reasons, empty or over-1 MiB strings, invalid UTF-8, invalid
offsets, trailing data, and arithmetic overflow. Legacy headers and all
separate metric/cost sections are rejected; this repository has no legacy
reader or compatibility path.

The analysis output contract is described in [Analysis JSON v2](ANALYSIS_V2.md).
