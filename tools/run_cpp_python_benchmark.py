"""Measure the existing Python batch path against the C++ GSR-producing path."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

from gachasimulate.builder import build_from_files
from gachasimulate.core import simulate_fixed_runs
from gachasimulate.engine import MonteCarlo


ROOT = Path(__file__).resolve().parents[1]
CASES = sorted((ROOT / "benchmark" / "cases").iterdir())
COMPILER = (
    "import { readFileSync } from 'node:fs';"
    "import { compile_yaml } from './packages/config-compiler/dist/index.js';"
    "const [config, termination] = process.argv.slice(1);"
    "process.stdout.write(JSON.stringify(compile_yaml(readFileSync(config, 'utf8'), readFileSync(termination, 'utf8')).ir));"
)


def median(values: list[float]) -> float:
    return statistics.median(values)


def compile_ir(case: Path, output: Path) -> None:
    completed = subprocess.run(
        [
            "node",
            "--input-type=module",
            "--eval",
            COMPILER,
            str(case / "config.yaml"),
            str(case / "termination.yaml"),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    output.write_text(completed.stdout, encoding="utf-8")


def python_time(case: Path, runs: int, seed: int, workers: int, repeats: int) -> tuple[float, int]:
    context = build_from_files(case / "config.yaml", case / "termination.yaml")
    timings: list[float] = []
    result = None
    for _ in range(repeats):
        start = time.perf_counter()
        result = simulate_fixed_runs(
            MonteCarlo(context, seed=seed), total_runs=runs, workers=workers
        )
        timings.append(time.perf_counter() - start)
    assert result is not None
    return median(timings), int(result["total_draw"])


def cpp_time(
    executable: Path, ir: Path, runs: int, seed: int, threads: int, repeats: int, directory: Path
) -> tuple[float, int, int]:
    timings: list[float] = []
    payload: dict[str, int | float] | None = None
    for index in range(repeats):
        output = directory / f"{ir.stem}-{threads}-{index}.gsr"
        completed = subprocess.run(
            [
                str(executable),
                "--ir",
                str(ir),
                "--total-runs",
                str(runs),
                "--seed",
                str(seed),
                "--threads",
                str(threads),
                "--output",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(completed.stdout)
        timings.append(float(payload["elapsed_ms"]) / 1000)
        output.unlink()
    assert payload is not None
    return median(timings), int(payload["total_draw"]), int(payload["gsr_bytes"])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--cpp", type=Path, required=True, help="gachasimulate-benchmark executable"
    )
    parser.add_argument("--runs", type=int, default=100)
    parser.add_argument("--seed", type=int, default=123)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--medium-runs", type=int, default=10_000)
    parser.add_argument("--parallel-runs", type=int, default=100_000)
    parser.add_argument("--parallel-workers", type=int, default=16)
    parser.add_argument(
        "--report", type=Path, default=ROOT / "docs" / "CPP_PYTHON_PERFORMANCE_BASELINE.md"
    )
    args = parser.parse_args()
    if (
        min(args.runs, args.medium_runs, args.parallel_runs, args.repeats, args.parallel_workers)
        < 1
        or args.warmups < 0
    ):
        raise SystemExit(
            "runs, repeats, and parallel workers must be positive; warmups must be non-negative"
        )
    executable = args.cpp.resolve()
    threads = min(os.cpu_count() or 1, args.runs)
    rows: list[str] = []
    medium_rows: list[str] = []
    parallel_rows: list[str] = []
    with tempfile.TemporaryDirectory(prefix="gachasimulate-benchmark-") as temp:
        directory = Path(temp)
        for case in CASES:
            ir = directory / f"{case.name}.json"
            compile_ir(case, ir)
            for _ in range(args.warmups):
                python_time(case, args.runs, args.seed, 1, 1)
                cpp_time(executable, ir, args.runs, args.seed, 1, 1, directory)
                cpp_time(executable, ir, args.runs, args.seed, threads, 1, directory)
            py_seconds, py_draws = python_time(case, args.runs, args.seed, 1, args.repeats)
            cpp_one, one_draws, one_size = cpp_time(
                executable, ir, args.runs, args.seed, 1, args.repeats, directory
            )
            cpp_many, many_draws, many_size = cpp_time(
                executable, ir, args.runs, args.seed, threads, args.repeats, directory
            )
            assert py_draws > 0 and one_draws > 0 and many_draws > 0
            rows.append(
                f"| {case.name} | {py_seconds * 1000:.2f} | {cpp_one * 1000:.2f} | {cpp_many * 1000:.2f} | "
                f"{cpp_one / args.runs * 1000:.3f} | {cpp_many / args.runs * 1000:.3f} | "
                f"{cpp_one / one_draws * 1000:.4f} | {cpp_many / many_draws * 1000:.4f} | "
                f"{one_size} | {many_size} | {py_seconds / cpp_one:.2f}x | {py_seconds / cpp_many:.2f}x |"
            )
            for _ in range(args.warmups):
                python_time(case, args.medium_runs, args.seed, 1, 1)
                python_time(case, args.medium_runs, args.seed, args.parallel_workers, 1)
                cpp_time(executable, ir, args.medium_runs, args.seed, 1, 1, directory)
                cpp_time(
                    executable, ir, args.medium_runs, args.seed, args.parallel_workers, 1, directory
                )
            py_medium_one, _ = python_time(case, args.medium_runs, args.seed, 1, args.repeats)
            py_medium_many, _ = python_time(
                case, args.medium_runs, args.seed, args.parallel_workers, args.repeats
            )
            cpp_medium_one, _, _ = cpp_time(
                executable, ir, args.medium_runs, args.seed, 1, args.repeats, directory
            )
            cpp_medium_many, _, _ = cpp_time(
                executable,
                ir,
                args.medium_runs,
                args.seed,
                args.parallel_workers,
                args.repeats,
                directory,
            )
            medium_rows.append(
                f"| {case.name} | {py_medium_one * 1000:.2f} | {py_medium_many * 1000:.2f} | "
                f"{cpp_medium_one * 1000:.2f} | {cpp_medium_many * 1000:.2f} | "
                f"{py_medium_one / cpp_medium_one:.2f}x | {py_medium_many / cpp_medium_many:.2f}x |"
            )
            for _ in range(args.warmups):
                python_time(case, args.parallel_runs, args.seed, args.parallel_workers, 1)
                cpp_time(
                    executable,
                    ir,
                    args.parallel_runs,
                    args.seed,
                    args.parallel_workers,
                    1,
                    directory,
                )
            py_parallel, _ = python_time(
                case, args.parallel_runs, args.seed, args.parallel_workers, args.repeats
            )
            cpp_parallel, cpp_parallel_draws, cpp_parallel_size = cpp_time(
                executable,
                ir,
                args.parallel_runs,
                args.seed,
                args.parallel_workers,
                args.repeats,
                directory,
            )
            parallel_rows.append(
                f"| {case.name} | {py_parallel * 1000:.2f} | {cpp_parallel * 1000:.2f} | "
                f"{py_parallel / args.parallel_runs * 1000:.4f} | {cpp_parallel / args.parallel_runs * 1000:.4f} | "
                f"{cpp_parallel / cpp_parallel_draws * 1000:.4f} | {cpp_parallel_size} | {py_parallel / cpp_parallel:.2f}x |"
            )
    args.report.write_text(
        "# C++ / Python Performance Baseline\n\n"
        f"Generated with `tools/run_cpp_python_benchmark.py --runs {args.runs} --medium-runs {args.medium_runs} --parallel-runs {args.parallel_runs} --parallel-workers {args.parallel_workers} --seed {args.seed} --repeats {args.repeats} --warmups {args.warmups}`. "
        f"C++ multi-thread runs use {threads} logical CPUs.\n\n"
        "| Case | Python 1T ms | C++ 1T ms | C++ MT ms | C++ 1T ms/run | C++ MT ms/run | C++ 1T ms/draw | C++ MT ms/draw | C++ 1T GSR B | C++ MT GSR B | Python/C++ 1T | Python/C++ MT |\n"
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n"
        + "\n".join(rows)
        + "\n\n## Mixed workload (10,000 runs, 16 workers/threads)\n\n"
        "Python 16P is `ProcessPoolExecutor`; C++ 16T is `std::thread`.\n\n"
        "| Case | Python 1T ms | Python 16P ms | C++ 1T ms | C++ 16T ms | Python/C++ 1T | Python/C++ parallel |\n"
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n"
        + "\n".join(medium_rows)
        + "\n\n## Parallel throughput (100,000 runs, 16 workers/threads)\n\n"
        "Python uses `ProcessPoolExecutor`; C++ uses `std::thread`. Both measures include their normal batch orchestration; only C++ writes GSR.\n\n"
        "| Case | Python 16P ms | C++ 16T ms | Python ms/run | C++ ms/run | C++ ms/draw | C++ GSR B | Python/C++ |\n"
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n"
        + "\n".join(parallel_rows)
        + "\n\nC++ timing is `RuntimeProgram` load + fixed-run simulation + GSR write. Python timing is the existing `simulate_fixed_runs` batch path and does not write a result file; the columns are therefore not a pure compute-only comparison. Temporary IR and GSR files are discarded.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
