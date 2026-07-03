from __future__ import annotations

import json
from pathlib import Path

import pytest

from gachasimulate.cli import main
from gachasimulate.core import load_simulation_result


def test_cli_saves_total_draw_result_pair(tmp_path: Path) -> None:
    exit_code = main(
        [
            "--config",
            "test",
            "--termination",
            "termination",
            "--target-total-draw",
            "1",
            "--seed",
            "7",
            "--workers",
            "1",
            "--results-dir",
            str(tmp_path),
        ]
    )

    assert exit_code == 0
    result_path = tmp_path / "test_termination_draw1_seed7_workers1.npz"
    visualize_path = tmp_path / "test_termination_draw1_seed7_workers1_visualize.json"
    assert result_path.exists()
    assert visualize_path.exists()

    result = load_simulation_result(result_path)
    assert result["seed"] == 7
    assert result["total_draw"] >= 1

    visualize_input = json.loads(visualize_path.read_text(encoding="utf-8"))
    assert visualize_input["draw_counts"] == result["total_draw"]


def test_cli_saves_total_runs_result_pair(tmp_path: Path) -> None:
    exit_code = main(
        [
            "--config",
            "test",
            "--termination",
            "termination.yaml",
            "--total-runs",
            "2",
            "--seed",
            "8",
            "--workers",
            "1",
            "--results-dir",
            str(tmp_path),
        ]
    )

    assert exit_code == 0
    result_path = tmp_path / "test_termination_runs2_seed8_workers1.npz"
    visualize_path = tmp_path / "test_termination_runs2_seed8_workers1_visualize.json"
    assert result_path.exists()
    assert visualize_path.exists()

    result = load_simulation_result(result_path)
    assert result["seed"] == 8
    assert result["total_runs"] == 2


@pytest.mark.parametrize(
    "args",
    [
        [
            "--config",
            "test",
            "--termination",
            "termination",
        ],
        [
            "--config",
            "test",
            "--termination",
            "termination",
            "--target-total-draw",
            "1",
            "--total-runs",
            "1",
        ],
    ],
)
def test_cli_requires_exactly_one_target(args: list[str]) -> None:
    with pytest.raises(SystemExit):
        main(args)
