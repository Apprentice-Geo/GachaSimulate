from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Sequence
from tqdm import tqdm

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
    config_group = parser.add_mutually_exclusive_group(required=True)
    config_group.add_argument("--config", help="Config combination under configs/.")
    config_group.add_argument("--config-dir", type=Path, help="Explicit config directory.")
    parser.add_argument("--termination", required=True, help="Termination yaml name.")
    target_group = parser.add_mutually_exclusive_group(required=True)
    target_group.add_argument("--target-total-draw", type=_positive_int)
    target_group.add_argument("--total-runs", type=_positive_int)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--workers", type=_positive_int, default=1)
    parser.add_argument("--metric", choices=("draw", "cost"), default="draw")
    parser.add_argument("--results-dir", type=Path, default=DEFAULT_RESULTS_DIR)
    parser.add_argument("--output-format", choices=("text", "jsonl"), default="text")
    return parser


def _resolve_config_paths(config_name: str, termination_name: str) -> tuple[Path, Path]:
    config_dir = CONFIG_ROOT / config_name
    config_path = config_dir / "config.yaml"
    termination_path = config_dir / _termination_filename(termination_name)
    return config_path, termination_path


def _resolve_config_dir_paths(config_dir: Path, termination_name: str) -> tuple[Path, Path]:
    config_dir = config_dir.resolve()
    termination_input = Path(termination_name)
    if termination_input.is_absolute() or termination_input.name != termination_name:
        raise ValueError("termination must be a relative filename")
    config_path = config_dir / "config.yaml"
    termination_path = (config_dir / _termination_filename(termination_name)).resolve()
    if not termination_path.is_relative_to(config_dir):
        raise ValueError("termination must be inside config directory")
    return config_path, termination_path


def _json_event(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _output_stem(
    *,
    config_name: str,
    termination_name: str,
    goal_kind: str,
    goal_value: int,
    metric: str,
    seed: int,
    workers: int,
) -> str:
    termination_stem = Path(_termination_filename(termination_name)).stem
    return (
        f"{config_name}_{termination_stem}_{goal_kind}{goal_value}_"
        f"metric{metric}_seed{seed}_workers{workers}"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)

    jsonl = args.output_format == "jsonl"
    if jsonl:
        _json_event({"type": "started"})

    try:
        if jsonl:
            _json_event({"type": "stage", "stage": "loading_config"})
        if args.config_dir is not None:
            config_path, termination_path = _resolve_config_dir_paths(
                args.config_dir, args.termination
            )
            config_name = args.config_dir.resolve().name
        else:
            config_path, termination_path = _resolve_config_paths(args.config, args.termination)
            config_name = args.config
        if not config_path.exists():
            raise FileNotFoundError(f"config file not found: {config_path}")
        if not termination_path.exists():
            raise FileNotFoundError(f"termination file not found: {termination_path}")

        ctx = build_from_files(config_path, termination_path)
        if args.metric == "cost" and ctx.cost_index is None:
            raise ValueError("metric cost requires a configured cost item")
        simulator = MonteCarlo(ctx, seed=args.seed)
        goal_kind = "draw" if args.target_total_draw is not None else "runs"
        goal_value = args.target_total_draw or args.total_runs
        progress_total = goal_value
        progress_unit = "draws" if goal_kind == "draw" else "runs"
        last_progress = 0
        last_emit = 0.0
        pbar = None if jsonl else tqdm(total=progress_total, desc="Simulating", unit=progress_unit)

        def progress_callback(completed: int, total: int) -> None:
            nonlocal last_progress, last_emit
            completed = max(last_progress, min(completed, total))
            if pbar is not None:
                pbar.update(completed - last_progress)
            now = time.monotonic()
            if jsonl and (now - last_emit >= 0.1 or completed == total):
                _json_event(
                    {
                        "type": "progress",
                        "completed": completed,
                        "total": total,
                        "unit": progress_unit,
                    }
                )
                last_emit = now
            last_progress = completed

        if jsonl:
            _json_event({"type": "stage", "stage": "simulating"})
        if args.target_total_draw is not None:
            result = simulate_until_total_draw(
                simulator,
                target_total_draw=args.target_total_draw,
                workers=args.workers,
                progress_callback=progress_callback,
            )
        else:
            result = simulate_fixed_runs(
                simulator,
                total_runs=args.total_runs,
                workers=args.workers,
                progress_callback=progress_callback,
            )
        if pbar is not None:
            pbar.close()

        if jsonl:
            _json_event({"type": "stage", "stage": "saving"})
        args.results_dir.mkdir(parents=True, exist_ok=True)
        stem = _output_stem(
            config_name=config_name,
            termination_name=args.termination,
            goal_kind=goal_kind,
            goal_value=goal_value,
            metric=args.metric,
            seed=args.seed,
            workers=args.workers,
        )
        result_path = (args.results_dir / f"{stem}.npz").resolve()
        visualize_path = (args.results_dir / f"{stem}_visualize.json").resolve()
        save_simulation_result(result_path, result)
        save_visualize_input(visualize_path, result, metric=args.metric)

        if jsonl:
            _json_event(
                {
                    "type": "completed",
                    "result_path": str(result_path),
                    "visualize_path": str(visualize_path),
                    "total_runs": int(result["total_runs"]),
                    "total_draw": int(result["total_draw"]),
                }
            )
        else:
            print(f"config: {config_path}")
            print(f"termination: {termination_path}")
            print(f"target: {goal_kind}={goal_value}")
            print(f"metric: {args.metric}")
            print(f"total_draw: {int(result['total_draw'])}")
            print(f"total_runs: {int(result['total_runs'])}")
            print(f"npz: {result_path}")
            print(f"visualize_json: {visualize_path}")
        return 0
    except Exception as error:
        if jsonl:
            _json_event({"type": "error", "message": str(error)})
            print(str(error), file=sys.stderr, flush=True)
            return 1
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
