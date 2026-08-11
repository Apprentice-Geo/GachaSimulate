# GSR v1

GSR is a little-endian binary result interchange format. All versions in this repository are integer major versions.

The fixed header is 96 bytes:

| Offset | Field |
| ---: | --- |
| 0 | `char[4]` magic: `GSR\0` |
| 4 | `u32` version: `1` |
| 8 | `u32` header size: `96` |
| 12 | `u32` flags (`bit 0`: cost array present) |
| 16 | `u64` total runs |
| 24 | `u64` total draws |
| 32 | `i64` total cost |
| 40 | `i64` seed |
| 48 | `u32` reason count |
| 52 | `u32` reserved, zero |
| 56 | `u64` draw offset |
| 64 | `u64` cost offset (`0` if omitted) |
| 72 | `u64` reason offset |
| 80 | `u64` string-table offset |
| 88 | `u64` file size |

`draw` is `u64[total_runs]`; optional `cost` is `i64[total_runs]`; `reason` is
`u32[total_runs]`. The string table stores reason IDs in ascending order as
`u32 UTF-8 byte length` followed by bytes. Readers reject files above 4 GiB,
more than 500,000,000 runs, more than 65,536 reasons, or a reason longer than
1 MiB. Offsets must be monotonic, non-overlapping, and exactly in range.

`cpp/tests/gsr_v1_fixture.hex` 是语言无关的有效字节 fixture；C++ writer 必须逐字节匹配，后续 reader 也复用同一 fixture。
