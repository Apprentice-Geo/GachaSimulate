from __future__ import annotations

import argparse
from pathlib import Path
from typing import Sequence

from .builder import build_from_files
from .core import (
    save_simulation_result,
    save_visualize_input,
    simulate_fixed_runs,
    simulate_until_total_draw,
)
from .engine import MonteCarlo

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CONFIG_ROOT = PROJECT_ROOT / "configs"
DEFAULT_RESULTS_DIR = PROJECT_ROOT / "results"


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return parsed


def _termination_filename(value: str) -> str:
    path = Path(value)
    if path.suffix:
        return path.name
    return f"{path.name}.yaml"


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a configured gacha simulation and save npz/json results."
    )
    parser.add_argument("--config", required=True, help="Config combination under configs/.")
    parser.add_argument("--termination", required=True, help="Termination yaml name.")
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument("--target-total-draw", type=_positive_int)
    target_group.add_argument("--total-runs", type=_positive_int)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--workers", type=_positive_int, default=1)
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)
    return parser


def _resolve_config_paths(config_name: str, termination_name: str) -> tuple[Path, Path]:
    config_dir = CONFIG_ROOT / config_name
    config_path = config_dir / "config.yaml"
    termination_path = config_dir / _termination_filename(termination_name)
    return config_path, termination_path


def _output_stem(
    *,
    config_name: str,
    termination_name: str,
    goal_kind: str,
    goal_value: int,
    seed: int,
    workers: int,
) -> str:
    termination_stem = Path(_termination_filename(termination_name)).stem
    return f"{config_name}_{termination_stem}_{goal_kind}{goal_value}_seed{seed}_workers{workers}"


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    config_path, termination_path = _resolve_config_paths(args.config, args.termination)
    if not config_path.exists():
        parser.error(f"config file not found: {config_path}")
    if not termination_path.exists():
        parser.error(f"termination file not found: {termination_path}")

    ctx = build_from_files(config_path, termination_path)
    simulator = MonteCarlo(ctx, seed=args.seed)

    if args.target_total_draw is not None:
        goal_kind = "draw"
        goal_value = args.target_total_draw
        result = simulate_until_total_draw(
            simulator,
            target_total_draw=args.target_total_draw,
            workers=args.workers,
        )
    else:
        goal_kind = "runs"
        goal_value = args.total_runs
        result = simulate_fixed_runs(
            simulator,
            total_runs=args.total_runs,
            workers=args.workers,
        )

    args.results_dir.mkdir(parents=True, exist_ok=True)
    stem = _output_stem(
        config_name=args.config,
        termination_name=args.termination,
        goal_kind=goal_kind,
        goal_value=goal_value,
        seed=args.seed,
        workers=args.workers,
    )
    result_path = args.results_dir / f"{stem}.npz"
    visualize_path = args.results_dir / f"{stem}_visualize.json"

    save_simulation_result(result_path, result)
    save_visualize_input(visualize_path, result)

    print(f"config: {config_path}")
    print(f"termination: {termination_path}")
    print(f"target: {goal_kind}={goal_value}")
    print(f"total_draw: {int(result['total_draw'])}")
    print(f"total_runs: {int(result['total_runs'])}")
    print(f"npz: {result_path}")
    print(f"visualize_json: {visualize_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
