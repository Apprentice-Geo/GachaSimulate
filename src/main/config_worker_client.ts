import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  NATIVE_PROCESS_TIMEOUT_MS,
  wait_for_process_close,
} from "./native_process";
import type {
  ConfigWork,
  ConfigWorkerOperation,
  ConfigWorkerOperations,
  ConfigWorkerResponse,
} from "./config_worker_protocol";

export type ConfigWorkerThread = Pick<
  Worker,
  "postMessage" | "on" | "terminate" | "ref" | "unref"
>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function create_worker(): ConfigWorkerThread {
  const compiled = join(__dirname, "config_worker.js");
  if (existsSync(compiled)) return new Worker(compiled);
  const source = join(__dirname, "config_worker.ts");
  if (!existsSync(source))
    throw new Error(`configuration worker not found: ${compiled}`);
  const register = createRequire(__filename).resolve("tsx/cjs");
  return new Worker(
    `require(${JSON.stringify(register)}); require(${JSON.stringify(source)});`,
    { eval: true },
  );
}

/** One restartable worker; failures reject all requests owned by that instance. */
export class ConfigWorkerClient implements ConfigWork {
  private worker: ConfigWorkerThread | null = null;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private suspended = false;
  private stopping: Promise<void> | null = null;
  private readonly retiring = new Set<ConfigWorkerThread>();
  private readonly terminations = new Map<ConfigWorkerThread, Promise<void>>();
  private readonly exited = new WeakSet<ConfigWorkerThread>();
  private readonly exit_waiters = new Map<ConfigWorkerThread, () => void>();

  constructor(
    private readonly factory = create_worker,
    private readonly close_timeout_ms = NATIVE_PROCESS_TIMEOUT_MS,
  ) {}

  private ensure_worker(): ConfigWorkerThread {
    if (this.suspended || this.stopping)
      throw new Error("configuration work is stopped during shutdown");
    if (this.worker) return this.worker;
    const worker = this.factory();
    this.worker = worker;
    worker.on("message", (response: ConfigWorkerResponse) => {
      if (this.worker !== worker) return;
      const request = this.pending.get(response.id);
      if (!request) return;
      this.pending.delete(response.id);
      if (response.ok) request.resolve(response.value);
      else request.reject(new Error(response.message));
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", (error: Error) => this.fail_worker(worker, error));
    worker.on("exit", (code: number) => {
      this.exited.add(worker);
      this.retiring.delete(worker);
      this.exit_waiters.get(worker)?.();
      this.exit_waiters.delete(worker);
      this.fail_worker(
        worker,
        new Error(`configuration worker exited (${code})`),
      );
    });
    worker.unref();
    return worker;
  }

  private fail_worker(worker: ConfigWorkerThread, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    void this.retire(worker).catch(() => undefined);
  }

  private retire(worker: ConfigWorkerThread): Promise<void> {
    if (this.exited.has(worker)) return Promise.resolve();
    const pending = this.terminations.get(worker);
    if (pending) return this.wait_for_retirement(pending);
    this.retiring.add(worker);
    let resolve_exit!: () => void;
    const exit = new Promise<void>((resolve) => {
      resolve_exit = resolve;
    });
    this.exit_waiters.set(worker, resolve_exit);
    const termination = Promise.race([
      Promise.resolve().then(() => worker.terminate()),
      exit,
    ]).then(() => {
      this.retiring.delete(worker);
    });
    this.terminations.set(worker, termination);
    void termination
      .finally(() => {
        if (this.terminations.get(worker) === termination)
          this.terminations.delete(worker);
        if (this.exit_waiters.get(worker) === resolve_exit)
          this.exit_waiters.delete(worker);
      })
      .catch(() => undefined);
    return this.wait_for_retirement(termination);
  }

  private wait_for_retirement(termination: Promise<void>): Promise<void> {
    return wait_for_process_close(
      termination,
      this.close_timeout_ms,
      "configuration worker exit timed out",
    );
  }

  async request<K extends ConfigWorkerOperation>(
    operation: K,
    value: ConfigWorkerOperations[K]["request"],
  ): Promise<ConfigWorkerOperations[K]["response"]> {
    try {
      if (this.suspended || this.stopping)
        throw new Error("configuration work is stopped during shutdown");
      if (this.retiring.size)
        await Promise.all(
          [...this.retiring].map((worker) => this.retire(worker)),
        );
      const worker = this.ensure_worker();
      const id = ++this.sequence;
      worker.ref();
      return new Promise((resolve, reject) => {
        this.pending.set(id, {
          resolve: (response) =>
            resolve(response as ConfigWorkerOperations[K]["response"]),
          reject,
        });
        try {
          worker.postMessage({ id, operation, value });
        } catch (reason) {
          this.fail_worker(
            worker,
            reason instanceof Error ? reason : new Error(String(reason)),
          );
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.suspended = true;
    const worker = this.worker;
    this.worker = null;
    for (const request of this.pending.values())
      request.reject(new Error("configuration work stopped during shutdown"));
    this.pending.clear();
    if (worker) this.retiring.add(worker);
    const stopping = Promise.allSettled(
      [...this.retiring].map((owned) => this.retire(owned)),
    ).then((outcomes) => {
      const errors = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, errors.map(String).join("\n"));
    });
    this.stopping = stopping;
    void stopping
      .finally(() => {
        if (this.stopping === stopping) this.stopping = null;
      })
      .catch(() => undefined);
    return stopping;
  }

  resume(): void {
    if (this.stopping)
      throw new Error("configuration worker is still stopping");
    this.suspended = false;
  }
}
