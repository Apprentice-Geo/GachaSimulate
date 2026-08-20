# Analysis JSON v2

`gachasimulate-analyze --input <file.gsr>` writes one JSON object to stdout;
diagnostics go to stderr and failures return non-zero. The object must satisfy
[`analysis_v2.schema.json`](schemas/analysis_v2.schema.json), with no unknown
fields.

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
  "termination_reason": []
}
```

The result item is selected when the simulation starts; the Compiler writes its
item index into IR. Its display name falls back to the item ID when no name is provided. All integer values are canonical
decimal strings. `values` is the sorted, strictly increasing set of distinct
期末结果 values; `cumulative` gives the CDF at each value and ends at `1`.
`totals.result` is the sum of every run's result value.

Percentiles, mean, CDF, and termination-reason algorithms are unchanged from
the previous analysis implementation: percentile uses `(n - 1) * p / 100`
linear interpolation truncated toward zero, mean is truncated toward zero,
`MEAN_LEVEL` is the proportion of sorted observations `<= MEAN`, and integer
termination percentages use the largest-remainder method with reason-name
ordering as the tie-breaker.

The TypeScript `validate_analysis` adapter enforces the AnalysisV2 schema and
cross-field invariants. View-model construction converts canonical integers to
JavaScript safe integers, rejects negative or out-of-range values, and merges a
separately validated DisplayConfig in memory. It never writes a sidecar or
changes the GSR.
