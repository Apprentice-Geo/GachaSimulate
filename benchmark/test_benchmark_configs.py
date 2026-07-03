from __future__ import annotations

from pathlib import Path

import pytest

from gachasimulate.builder import build_from_files
from gachasimulate.engine import MonteCarlo

CASES_ROOT = Path(__file__).resolve().parent / "cases"
CASE_DIRS = sorted(path for path in CASES_ROOT.iterdir() if path.is_dir())


@pytest.mark.parametrize("case_dir", CASE_DIRS, ids=lambda path: path.name)
def test_benchmark_config_runs_to_termination(case_dir: Path) -> None:
    ctx = build_from_files(case_dir / "config.yaml", case_dir / "termination.yaml")

    for seed in range(3):
        state = MonteCarlo(ctx, seed=seed).run_once()

        assert state.terminate is True
        assert state.terminate_reason is not None
        assert int(state.inventory[ctx.draw_count_index]) > 0
