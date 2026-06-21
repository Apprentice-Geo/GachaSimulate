from gachasimulate.engine import MonteCarlo
import json
import numpy as np
from concurrent.futures import FIRST_COMPLETED, ProcessPoolExecutor, wait
from datetime import datetime
from multiprocessing import Manager
from queue import Empty
from typing import BinaryIO
from tqdm import tqdm

DEFAULT_VISUALIZE_TITLE = "核心模拟结果"
DEFAULT_VISUALIZE_TARGET = "未设置"
DEFAULT_VISUALIZE_NOTE = "MEAN 受极端抽数影响，P50 更接近“典型体验”，P95 更适合衡量高风险预算。MIN、MAX 受模拟次数影响，不代表理论极限抽数。"
DEFAULT_VISUALIZE_COST = 0


def _simulate_until_total_draw_serial(
    sim: MonteCarlo,
    target_total_draw: int,
    show_progress: bool,
    progress_queue=None,
    progress_interval: int = 0,
):
    """
    单进程持续运行完整模拟，直到累计抽数达到目标值
    """

    draw_count = []
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
        "lifetime_acquired": np.vstack(acquired_records).astype(np.int32),
        "terminate_reasons": np.array(terminate_reasons, dtype="U32"),
        "total_draw": np.int64(total_draw),
        "total_runs": np.int32(total_runs),
    }


def _simulate_until_total_draw_chunk(
    ctx, seed_sequence, target_total_draw: int, progress_queue, progress_interval: int
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


def _merge_simulation_results(results: list[dict], seed):
    return {
        "seed": seed,
        # 直接拼接各个结果的数组，draw_count和terminate_reasons是一维的，而lifetime_acquired是二维的
        # concatenate不指定axis默认是axis=0，即在第0维上拼接
        "draw_count": np.concatenate([result["draw_count"] for result in results]),
        # vstack是专门用于拼接二维数组的函数，这里的效果和concatenate(..., axis=0)一样
        "lifetime_acquired": np.vstack([result["lifetime_acquired"] for result in results]).astype(
            np.int32
        ),
        "terminate_reasons": np.concatenate([result["terminate_reasons"] for result in results]),
        "total_draw": np.int64(sum(int(result["total_draw"]) for result in results)),
        "total_runs": np.int32(sum(int(result["total_runs"]) for result in results)),
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


def _simulate_until_total_draw_parallel(sim: MonteCarlo, target_total_draw: int, workers: int):
    """
    多进程持续运行完整模拟，直到累计抽数达到目标值
    """
    targets = _split_target_total_draw(target_total_draw, workers)
    # 生成子进程的随机数种子，保证每个子进程的随机数序列独立且可复现
    seed_sequence = np.random.SeedSequence(sim.seed)
    child_seed_sequences = seed_sequence.spawn(len(targets))
    results: list[dict | None] = [None] * len(targets)
    progress_interval = max(10000, target_total_draw // 1000)

    with tqdm(total=target_total_draw, desc="Simulating", unit="draw") as pbar:
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
                    _update_progress_from_queue(progress_queue, pbar, target_total_draw)
                    for future in done_futures:
                        results[futures[future]] = future.result()

                _update_progress_from_queue(progress_queue, pbar, target_total_draw)

    return _merge_simulation_results([result for result in results if result], sim.seed)


def simulate_until_total_draw(sim: MonteCarlo, target_total_draw: int, workers: int | None = 1):
    if workers is None:
        workers = 1
    if workers < 1:
        raise ValueError("workers must be >= 1")
    if workers == 1 or target_total_draw <= 0:
        return _simulate_until_total_draw_serial(sim, target_total_draw, show_progress=True)
    return _simulate_until_total_draw_parallel(sim, target_total_draw, workers)


def save_simulation_result(path: str | BinaryIO, result: dict):

    np.savez_compressed(
        path,
        draw_count=result["draw_count"],
        lifetime_acquired=result["lifetime_acquired"],
        terminate_reasons=result["terminate_reasons"],
        total_draw=result["total_draw"],
        total_runs=result["total_runs"],
        has_seed=result["seed"] is not None,
        seed=0 if result["seed"] is None else int(result["seed"]),
        timestamp=str(datetime.now()),
    )


def _build_visualize_input(result: dict) -> dict:
    values = np.sort(np.asarray(result["draw_count"]))
    count = len(values)
    # 去重，counts是每个唯一值的出现次数，因此下面的前缀和除的是 count
    draws, draw_counts = np.unique(values, return_counts=True)
    # cumsum: cumulative sum，做前缀和
    cumulative = np.cumsum(draw_counts) / count
    mean_draw = int(np.mean(values))
    unique_reasons, reason_counts = np.unique(
        np.asarray(result["terminate_reasons"]), return_counts=True
    )

    return {
        "title": DEFAULT_VISUALIZE_TITLE,
        "target": DEFAULT_VISUALIZE_TARGET,
        "draw_counts": int(result["total_draw"]),
        "note": DEFAULT_VISUALIZE_NOTE,
        "statistic": {
            "P5": int(np.percentile(values, 5)),
            "P25": int(np.percentile(values, 25)),
            "P50": int(np.percentile(values, 50)),
            "P75": int(np.percentile(values, 75)),
            "P95": int(np.percentile(values, 95)),
            "MIN": int(np.min(values)),
            "MEAN_LEVEL": float(np.searchsorted(values, mean_draw, side="right") / count),
            "MEAN": mean_draw,
            "MAX": int(np.max(values)),
            "COST": DEFAULT_VISUALIZE_COST,
        },
        "termination_reason": [
            {
                "reason": str(reason),
                "proportion": int(round(int(reason_count) / count * 100)),
            }
            for reason, reason_count in zip(unique_reasons, reason_counts)
        ],
        "timestamp": int(datetime.now().timestamp()),
        "draws": draws.astype(int).tolist(),
        "cumulative": cumulative.astype(float).tolist(),
    }


def save_visualize_input(path: str | BinaryIO, result: dict):
    visualize_input = _build_visualize_input(result)
    content = json.dumps(visualize_input, ensure_ascii=False, indent=4) + "\n"

    if isinstance(path, str):
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    else:
        path.write(content.encode("utf-8"))


def load_simulation_result(path: str | BinaryIO):
    data = np.load(path, allow_pickle=False)

    return {
        "draw_count": data["draw_count"],
        "lifetime_acquired": data["lifetime_acquired"],
        "terminate_reasons": data["terminate_reasons"],
        "total_draw": int(data["total_draw"]),
        "total_runs": int(data["total_runs"]),
        "has_seed": bool(data["has_seed"]),
        "seed": int(data["seed"]) if data["has_seed"] else None,
        "timestamp": str(data["timestamp"]),
    }
