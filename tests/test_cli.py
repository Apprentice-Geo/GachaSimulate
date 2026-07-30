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
    result_path = tmp_path / "test_termination_draw1_metricdraw_seed7_workers1.npz"
    visualize_path = tmp_path / "test_termination_draw1_metricdraw_seed7_workers1_visualize.json"
    assert result_path.exists()
    assert visualize_path.exists()

    result = load_simulation_result(result_path)
    assert result["seed"] == 7
    assert result["total_draw"] >= 1

    visualize_input = json.loads(visualize_path.read_text(encoding="utf-8"))
    assert visualize_input["metric"] == "draw"
    assert visualize_input["total"] == result["total_draw"]


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
    result_path = tmp_path / "test_termination_runs2_metricdraw_seed8_workers1.npz"
    visualize_path = tmp_path / "test_termination_runs2_metricdraw_seed8_workers1_visualize.json"
    assert result_path.exists()
    assert visualize_path.exists()

    result = load_simulation_result(result_path)
    assert result["seed"] == 8
    assert result["total_runs"] == 2


def test_cli_saves_cost_visualization(tmp_path: Path) -> None:
    exit_code = main(
        [
            "--config",
            "test",
            "--termination",
            "termination",
            "--total-runs",
            "2",
            "--metric",
            "cost",
            "--results-dir",
            str(tmp_path),
        ]
    )

    assert exit_code == 0
    visualize_path = tmp_path / "test_termination_runs2_metriccost_seed0_workers1_visualize.json"
    result_path = tmp_path / "test_termination_runs2_metriccost_seed0_workers1.npz"
    result = load_simulation_result(result_path)
    visualize_input = json.loads(visualize_path.read_text(encoding="utf-8"))
    assert visualize_input["metric"] == "cost"
    assert visualize_input["total"] == result["total_cost"]
    assert visualize_input["values"]


def test_cli_rejects_cost_metric_when_config_has_no_cost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from gachasimulate import cli

    monkeypatch.setattr(cli, "CONFIG_ROOT", Path(__file__).parents[1] / "configs")

    with pytest.raises(SystemExit):
        main(
            [
                "--config",
                "sanliou_zhenpinchuanshuo",
                "--termination",
                "termination_skin",
                "--total-runs",
                "1",
                "--metric",
                "cost",
                "--results-dir",
                str(tmp_path),
            ]
        )

    assert list(tmp_path.iterdir()) == []


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
