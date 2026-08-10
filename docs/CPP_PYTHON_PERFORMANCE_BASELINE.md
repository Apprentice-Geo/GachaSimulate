# C++ / Python Performance Baseline

Generated with `tools/run_cpp_python_benchmark.py --runs 100 --medium-runs 10000 --parallel-runs 100000 --parallel-workers 16 --seed 123 --repeats 3 --warmups 1`. C++ multi-thread runs use 32 logical CPUs.

| Case | Python 1T ms | C++ 1T ms | C++ MT ms | C++ 1T ms/run | C++ MT ms/run | C++ 1T ms/draw | C++ MT ms/draw | C++ 1T GSR B | C++ MT GSR B | Python/C++ 1T | Python/C++ MT |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline_probability | 2.09 | 0.76 | 2.58 | 0.008 | 0.026 | 0.0005 | 0.0015 | 1327 | 1327 | 2.73x | 0.81x |
| condition_tree_rules | 4.68 | 1.13 | 3.01 | 0.011 | 0.030 | 0.0019 | 0.0050 | 1312 | 1312 | 4.14x | 1.55x |
| item_resolve_nested_draw | 1.80 | 0.81 | 3.61 | 0.008 | 0.036 | 0.0018 | 0.0064 | 1327 | 1327 | 2.23x | 0.50x |
| multi_path_termination | 0.76 | 0.97 | 3.13 | 0.010 | 0.031 | 0.0024 | 0.0078 | 1336 | 1336 | 0.78x | 0.24x |
| pool_switch_once_rules | 0.88 | 0.69 | 2.86 | 0.007 | 0.029 | 0.0015 | 0.0057 | 1327 | 1315 | 1.27x | 0.31x |
| weighted_pool | 3.90 | 1.01 | 3.38 | 0.010 | 0.034 | 0.0003 | 0.0010 | 1327 | 1327 | 3.87x | 1.15x |

## Mixed workload (10,000 runs, 16 workers/threads)

Python 16P is `ProcessPoolExecutor`; C++ 16T is `std::thread`.

| Case | Python 1T ms | Python 16P ms | C++ 1T ms | C++ 16T ms | Python/C++ 1T | Python/C++ parallel |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline_probability | 202.52 | 1033.57 | 20.60 | 9.43 | 9.83x | 109.65x |
| condition_tree_rules | 176.50 | 1025.68 | 21.13 | 9.40 | 8.35x | 109.09x |
| item_resolve_nested_draw | 209.23 | 1121.69 | 23.43 | 9.27 | 8.93x | 121.01x |
| multi_path_termination | 93.55 | 1180.24 | 14.47 | 10.08 | 6.47x | 117.07x |
| pool_switch_once_rules | 88.88 | 1039.53 | 13.36 | 7.80 | 6.65x | 133.32x |
| weighted_pool | 421.95 | 1105.67 | 32.03 | 10.78 | 13.18x | 102.61x |

## Parallel throughput (100,000 runs, 16 workers/threads)

Python uses `ProcessPoolExecutor`; C++ uses `std::thread`. Both measures include their normal batch orchestration; only C++ writes GSR.

| Case | Python 16P ms | C++ 16T ms | Python ms/run | C++ ms/run | C++ ms/draw | C++ GSR B | Python/C++ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline_probability | 1280.90 | 58.63 | 0.0128 | 0.0006 | 0.0000 | 1200127 | 21.85x |
| condition_tree_rules | 1212.94 | 56.94 | 0.0121 | 0.0006 | 0.0001 | 1200112 | 21.30x |
| item_resolve_nested_draw | 1160.18 | 52.12 | 0.0116 | 0.0005 | 0.0001 | 1200127 | 22.26x |
| multi_path_termination | 1133.62 | 43.85 | 0.0113 | 0.0004 | 0.0001 | 1200136 | 25.85x |
| pool_switch_once_rules | 1115.20 | 47.07 | 0.0112 | 0.0005 | 0.0001 | 1200127 | 23.69x |
| weighted_pool | 1721.64 | 71.44 | 0.0172 | 0.0007 | 0.0000 | 1200127 | 24.10x |

C++ timing is `RuntimeProgram` load + fixed-run simulation + GSR write. Python timing is the existing `simulate_fixed_runs` batch path and does not write a result file; the columns are therefore not a pure compute-only comparison. Temporary IR and GSR files are discarded.
