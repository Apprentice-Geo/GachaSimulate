from __future__ import annotations

from pathlib import Path

import pytest

from gachasimulate.builder import build_from_files
from gachasimulate.core import simulate_fixed_runs
from gachasimulate.engine import MonteCarlo

CASES_ROOT = Path(__file__).resolve().parent / "cases"
CASE_DIRS = sorted(path for path in CASES_ROOT.iterdir() if path.is_dir())
TOTAL_RUNS = 1


@pytest.mark.parametrize("case_dir", CASE_DIRS, ids=lambda path: path.name)
def test_fixed_runs_benchmark(case_dir: Path, benchmark) -> None:
    ctx = build_from_files(case_dir / "config.yaml", case_dir / "termination.yaml")

    def run_case():
        return simulate_fixed_runs(MonteCarlo(ctx, seed=0), total_runs=TOTAL_RUNS, workers=1)

    result = benchmark(run_case)

    assert int(result["total_runs"]) == TOTAL_RUNS
    assert len(result["draw_count"]) == TOTAL_RUNS
