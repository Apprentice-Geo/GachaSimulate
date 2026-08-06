import json
import os
import numpy as np
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime
from multiprocessing import Manager
from queue import Empty
from typing import BinaryIO, Callable
from tqdm import tqdm

from .engine import MonteCarlo


DEFAULT_VISUALIZE_TITLE = "模拟结果"
DEFAULT_VISUALIZE_TARGET = "未设置"
DEFAULT_VISUALIZE_NOTE = "MEAN 受极端值影响，P50 更接近“典型体验”，P95 更适合衡量高风险预算。MIN、MAX 受模拟次数影响，不代表理论极限。"
type SavePath = str | os.PathLike[str] | BinaryIO
ProgressCallback = Callable[[int, int], None]


def _simulate_until_total_draw_serial(
    sim: MonteCarlo,
    target_total_draw: int,
    show_progress: bool,
    progress_queue=None,
    progress_interval: int = 0,
    progress_callback: ProgressCallback | None = None,
):
    """
    单进程持续运行完整模拟，直到累计抽数达到目标值
    """

    draw_count = []
    cost = []
    acquired_records = []
    terminate_reasons = []

    total_draw = 0
    total_runs = 0
    pending_progress = 0

    progress = tqdm(
        total=target_total_draw,
        desc="Simulating",
        unit="draw",
        disable=not show_progress,
    )
    with progress as pbar:
        while total_draw < target_total_draw:
            state = sim.run_once()
            run_draw_count = int(state.inventory[sim.ctx.draw_count_index])

            draw_count.append(run_draw_count)
            if sim.ctx.cost_index is not None:
                cost.append(int(state.inventory[sim.ctx.cost_index]))
            acquired_records.append(state.acquired.copy())
            terminate_reasons.append(state.terminate_reason)

            total_draw += run_draw_count
            total_runs += 1

            if progress_queue is None:
                # 单进程模式更新进度条
                pbar.update(run_draw_count)

                # 防止超过总量导致进度条溢出
                if total_draw > target_total_draw:
                    pbar.update(target_total_draw - pbar.n)
                if progress_callback is not None:
                    progress_callback(min(total_draw, target_total_draw), target_total_draw)
            else:
                # 多进程模式通过队列发送进度更新
                pending_progress += run_draw_count
                if pending_progress >= progress_interval:
                    progress_queue.put(pending_progress)
                    pending_progress = 0

    if progress_queue is not None and pending_progress:
        progress_queue.put(pending_progress)

    return {
        "seed": sim.seed,
        "draw_count": np.asarray(draw_count, dtype=np.int32),
        "cost": np.asarray(cost, dtype=np.int32),
        "lifetime_acquired": np.vstack(acquired_records).astype(np.int32),
        "terminate_reasons": np.array(terminate_reasons, dtype="U32"),
        "total_draw": np.int64(total_draw),
        "total_cost": np.int64(sum(cost)),
        "total_runs": np.int32(total_runs),
        "has_cost": sim.ctx.cost_index is not None,
    }


def _simulate_until_total_draw_chunk(
    ctx,
    seed_sequence,
    target_total_draw: int,
    progress_queue,
    progress_interval: int,
):
    return _simulate_until_total_draw_serial(
        MonteCarlo(ctx, seed=seed_sequence),
        target_total_draw,
        show_progress=False,
        progress_queue=progress_queue,
        progress_interval=progress_interval,
    )


def _split_target_total_draw(target_total_draw: int, chunk_count: int) -> list[int]:
    base, remainder = divmod(target_total_draw, chunk_count)
    return [
        base + (1 if index < remainder else 0)
        for index in range(chunk_count)
        if base + (1 if index < remainder else 0) > 0
    ]


def _split_total_runs(total_runs: int, chunk_count: int) -> list[int]:
    base, remainder = divmod(total_runs, chunk_count)
    return [
        base + (1 if index < remainder else 0)
        for index in range(chunk_count)
        if base + (1 if index < remainder else 0) > 0
    ]


def _merge_simulation_results(results: list[dict], seed):
    return {
        "seed": seed,
        # 直接拼接各个结果的数组，draw_count和terminate_reasons是一维的，而lifetime_acquired是二维的
        # concatenate不指定axis默认是axis=0，即在第0维上拼接
        "draw_count": np.concatenate([result["draw_count"] for result in results]),
        "cost": np.concatenate([result["cost"] for result in results]),
        # vstack是专门用于拼接二维数组的函数，这里的效果和concatenate(..., axis=0)一样
        "lifetime_acquired": np.vstack([result["lifetime_acquired"] for result in results]).astype(
            np.int32
        ),
        "terminate_reasons": np.concatenate([result["terminate_reasons"] for result in results]),
        "total_draw": np.int64(sum(int(result["total_draw"]) for result in results)),
        "total_cost": np.int64(sum(int(result["total_cost"]) for result in results)),
        "total_runs": np.int32(sum(int(result["total_runs"]) for result in results)),
        "has_cost": bool(results[0]["has_cost"]),
    }


def _update_progress_from_queue(progress_queue, pbar, target_total_draw: int) -> None:
    while True:
        try:
            # 使用非阻塞读取，为空时捕获抛出的异常并退出循环
            progress_draw = int(progress_queue.get_nowait())
        except Empty:
            return

        remaining_draw = target_total_draw - pbar.n
        if remaining_draw <= 0:
            continue
        pbar.update(max(0, min(progress_draw, remaining_draw)))


def _drain_progress_queue(progress_queue, completed: int, total: int, callback):
    while True:
        try:
            increment = int(progress_queue.get_nowait())
        except Empty:
            return completed
        completed = min(total, completed + increment)
        callback(completed, total)


def _simulate_until_total_draw_parallel(
    sim: MonteCarlo,
    target_total_draw: int,
    workers: int,
    progress_callback: ProgressCallback | None = None,
):
    """
    多进程持续运行完整模拟，直到累计抽数达到目标值
    """
    targets = _split_target_total_draw(target_total_draw, workers)
    # 生成子进程的随机数种子，保证每个子进程的随机数序列独立且可复现
    seed_sequence = np.random.SeedSequence(sim.seed)
    child_seed_sequences = seed_sequence.spawn(len(targets))
    results: list[dict | None] = [None] * len(targets)
    progress_interval = max(10000, target_total_draw // 1000)

    callback = progress_callback or (lambda completed, total: None)
    with tqdm(
        total=target_total_draw,
        desc="Simulating",
        unit="draw",
        disable=progress_callback is not None,
    ) as pbar:
        with Manager() as manager:
            # 进程安全的队列,使用方式简单,能在多个进程之间安全传递 Python 对象
            # 缺点是它依赖 Manager 进程做代理，序列化和通信开销比较大，不适合特别高频、大数据量传输
            progress_queue = manager.Queue()
            with ProcessPoolExecutor(max_workers=workers) as executor:
                futures = {
                    executor.submit(
                        _simulate_until_total_draw_chunk,
                        sim.ctx,
                        child_seed_sequences[index],
                        target,
                        progress_queue,
                        progress_interval,
                    ): index
                    for index, target in enumerate(targets)
                }
                # 这是一个列表生成式的写法，futures是一个字典
                # 键是executor.submit(...)返回的future对象，值是对应的index
                pending_futures = set(futures)
                while pending_futures:
                    # 等待任务完成，超时设置为0.1s，从而在子进程运行过程中更新进度条
                    done_futures, pending_futures = wait(
                        pending_futures, timeout=0.1, return_when=FIRST_COMPLETED
                    )
                    # 根据子进程传回的抽数更新进度条
                    before = pbar.n
                    _update_progress_from_queue(progress_queue, pbar, target_total_draw)
                    if pbar.n != before:
                        callback(pbar.n, target_total_draw)
                    for future in done_futures:
                        results[futures[future]] = future.result()

                before = pbar.n
                _update_progress_from_queue(progress_queue, pbar, target_total_draw)
                if pbar.n != before:
                    callback(pbar.n, target_total_draw)

    callback(target_total_draw, target_total_draw)

    return _merge_simulation_results([result for result in results if result], sim.seed)


def _simulate_fixed_runs_serial(
    sim: MonteCarlo,
    total_runs: int,
    progress_queue=None,
    progress_interval: int = 0,
    progress_callback: ProgressCallback | None = None,
):
    draw_count = []
    cost = []
    acquired_records = []
    terminate_reasons = []

    total_draw = 0
    pending_progress = 0
    for _ in range(total_runs):
        state = sim.run_once()
        run_draw_count = int(state.inventory[sim.ctx.draw_count_index])

        draw_count.append(run_draw_count)
        if sim.ctx.cost_index is not None:
            cost.append(int(state.inventory[sim.ctx.cost_index]))
        acquired_records.append(state.acquired.copy())
        terminate_reasons.append(state.terminate_reason)

        total_draw += run_draw_count
        if progress_queue is None:
            if progress_callback is not None:
                progress_callback(len(draw_count), total_runs)
        else:
            pending_progress += 1
            if pending_progress >= progress_interval:
                progress_queue.put(pending_progress)
                pending_progress = 0

    if progress_queue is not None and pending_progress:
        progress_queue.put(pending_progress)

    return {
        "seed": sim.seed,
        "draw_count": np.asarray(draw_count, dtype=np.int32),
        "cost": np.asarray(cost, dtype=np.int32),
        "lifetime_acquired": np.vstack(acquired_records).astype(np.int32),
        "terminate_reasons": np.array(terminate_reasons, dtype="U32"),
        "total_draw": np.int64(total_draw),
        "total_cost": np.int64(sum(cost)),
        "total_runs": np.int32(total_runs),
        "has_cost": sim.ctx.cost_index is not None,
    }


def _simulate_fixed_runs_chunk(
    ctx, seed_sequence, total_runs: int, progress_queue, progress_interval: int
):
    return _simulate_fixed_runs_serial(
        MonteCarlo(ctx, seed=seed_sequence),
        total_runs,
        progress_queue=progress_queue,
        progress_interval=progress_interval,
    )


def _simulate_fixed_runs_parallel(
    sim: MonteCarlo,
    total_runs: int,
    workers: int,
    progress_callback: ProgressCallback | None = None,
):
    targets = _split_total_runs(total_runs, workers)
    seed_sequence = np.random.SeedSequence(sim.seed)
    child_seed_sequences = seed_sequence.spawn(len(targets))
    results: list[dict | None] = [None] * len(targets)

    progress_interval = max(1, total_runs // 1000)
    callback = progress_callback or (lambda completed, total: None)
    with Manager() as manager:
        progress_queue = manager.Queue()
        with ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(
                    _simulate_fixed_runs_chunk,
                    sim.ctx,
                    child_seed_sequences[index],
                    target,
                    progress_queue,
                    progress_interval,
                ): index
                for index, target in enumerate(targets)
            }
            pending_futures = set(futures)
            completed = 0
            while pending_futures:
                done_futures, pending_futures = wait(
                    pending_futures, timeout=0.1, return_when=FIRST_COMPLETED
                )
                completed = _drain_progress_queue(progress_queue, completed, total_runs, callback)
                for future in done_futures:
                    results[futures[future]] = future.result()
            completed = _drain_progress_queue(progress_queue, completed, total_runs, callback)
            callback(total_runs, total_runs)

    return _merge_simulation_results([result for result in results if result], sim.seed)


def simulate_until_total_draw(
    sim: MonteCarlo,
    target_total_draw: int,
    workers: int | None = 1,
    progress_callback: ProgressCallback | None = None,
):
    if workers is None:
        workers = 1
    if workers < 1:
        raise ValueError("workers must be >= 1")
    if workers == 1 or target_total_draw <= 0:
        return _simulate_until_total_draw_serial(
            sim,
            target_total_draw,
            show_progress=progress_callback is None,
            progress_callback=progress_callback,
        )
    return _simulate_until_total_draw_parallel(sim, target_total_draw, workers, progress_callback)


def simulate_fixed_runs(
    sim: MonteCarlo,
    total_runs: int,
    workers: int | None = 1,
    progress_callback: ProgressCallback | None = None,
):
    if total_runs < 1:
        raise ValueError("total_runs must be >= 1")
    if workers is None:
        workers = 1
    if workers < 1:
        raise ValueError("workers must be >= 1")
    if workers == 1:
        return _simulate_fixed_runs_serial(sim, total_runs, progress_callback=progress_callback)
    return _simulate_fixed_runs_parallel(sim, total_runs, workers, progress_callback)


def _ensure_parent_dir(path: str | os.PathLike[str]) -> None:
    os.makedirs(os.fspath(os.path.dirname(os.fspath(path)) or "."), exist_ok=True)


def save_simulation_result(path: SavePath, result: dict):
    if isinstance(path, str | os.PathLike):
        _ensure_parent_dir(path)

    np.savez_compressed(
        path,
        draw_count=result["draw_count"],
        cost=result["cost"],
        lifetime_acquired=result["lifetime_acquired"],
        terminate_reasons=result["terminate_reasons"],
        total_draw=result["total_draw"],
        total_cost=result["total_cost"],
        total_runs=result["total_runs"],
        has_cost=result["has_cost"],
        has_seed=result["seed"] is not None,
        seed=0 if result["seed"] is None else int(result["seed"]),
        timestamp=str(datetime.now()),
    )


def _build_reason_proportions(terminate_reasons: np.ndarray) -> list[dict[str, int | str]]:
    unique_reasons, reason_counts = np.unique(terminate_reasons, return_counts=True)
    reason_entries = sorted(
        (
            {
                "reason": str(reason),
                "count": int(reason_count),
            }
            for reason, reason_count in zip(unique_reasons, reason_counts)
        ),
        key=lambda item: str(item["reason"]),
    )
    total_count = sum(int(item["count"]) for item in reason_entries)

    exact_proportions = [int(item["count"]) * 100 / total_count for item in reason_entries]
    proportions = [int(proportion) for proportion in exact_proportions]
    remainder = 100 - sum(proportions)
    remainder_order = sorted(
        range(len(reason_entries)),
        key=lambda index: (
            -(exact_proportions[index] - proportions[index]),
            str(reason_entries[index]["reason"]),
        ),
    )
    for index in remainder_order[:remainder]:
        proportions[index] += 1

    return [
        {
            "reason": str(item["reason"]),
            "proportion": proportions[index],
        }
        for index, item in enumerate(reason_entries)
    ]


def _build_visualize_input(result: dict, metric: str = "draw") -> dict:
    if metric not in {"draw", "cost"}:
        raise ValueError("metric must be 'draw' or 'cost'")
    if metric == "cost" and not bool(result["has_cost"]):
        raise ValueError("cost metric requires a configured cost item")

    source_key = "draw_count" if metric == "draw" else "cost"
    total_key = "total_draw" if metric == "draw" else "total_cost"
    values = np.sort(np.asarray(result[source_key]))
    count = len(values)
    # 去重，counts是每个唯一值的出现次数，因此下面的前缀和除的是 count
    unique_values, value_counts = np.unique(values, return_counts=True)
    # cumsum: cumulative sum，做前缀和
    cumulative = np.cumsum(value_counts) / count
    mean_value = int(np.mean(values))

    return {
        "title": DEFAULT_VISUALIZE_TITLE,
        "target": DEFAULT_VISUALIZE_TARGET,
        "metric": metric,
        "total": int(result[total_key]),
        "note": DEFAULT_VISUALIZE_NOTE,
        "statistic": {
            "P5": int(np.percentile(values, 5)),
            "P25": int(np.percentile(values, 25)),
            "P50": int(np.percentile(values, 50)),
            "P75": int(np.percentile(values, 75)),
            "P95": int(np.percentile(values, 95)),
            "MIN": int(np.min(values)),
            "MEAN_LEVEL": float(np.searchsorted(values, mean_value, side="right") / count),
            "MEAN": mean_value,
            "MAX": int(np.max(values)),
        },
        "termination_reason": _build_reason_proportions(np.asarray(result["terminate_reasons"])),
        "timestamp": int(datetime.now().timestamp()),
        "values": unique_values.astype(int).tolist(),
        "cumulative": cumulative.astype(float).tolist(),
        "price": "",
        "unit": "",
    }


def save_visualize_input(path: SavePath, result: dict, metric: str = "draw"):
    visualize_input = _build_visualize_input(result, metric=metric)
    content = json.dumps(visualize_input, ensure_ascii=False, indent=4) + "\n"

    if isinstance(path, str | os.PathLike):
        _ensure_parent_dir(path)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    else:
        path.write(content.encode("utf-8"))


def load_simulation_result(path: SavePath):
    data = np.load(path, allow_pickle=False)

    return {
        "draw_count": data["draw_count"],
        "cost": data["cost"],
        "lifetime_acquired": data["lifetime_acquired"],
        "terminate_reasons": data["terminate_reasons"],
        "total_draw": int(data["total_draw"]),
        "total_cost": int(data["total_cost"]),
        "total_runs": int(data["total_runs"]),
        "has_cost": bool(data["has_cost"]),
        "has_seed": bool(data["has_seed"]),
        "seed": int(data["seed"]) if data["has_seed"] else None,
        "timestamp": str(data["timestamp"]),
    }
