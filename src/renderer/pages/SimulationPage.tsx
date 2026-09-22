import { FolderOpen, Play, Search } from "lucide-react";
import { useState, useEffect } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import type { InstalledConfig } from "../../shared/installed_config";
import {
  default_result_item,
  filter_result_items,
  selected_result_item,
} from "../simulation_items";
import {
  MAX_TOTAL_RUNS,
  validate_simulation_request,
  type SimulationRequest,
  type SimulationStage,
  type SimulationStatus,
} from "../../shared/simulation";

const status_labels: Record<SimulationStatus, string> = {
  idle: "待运行",
  starting: "正在启动",
  running: "模拟中",
  saving: "正在保存",
  completed: "已完成",
  failed: "运行失败",
  cancelling: "正在取消",
  cancelled: "已取消",
};

export function SimulationPage({ active }: { active: boolean }) {
  const [configs, set_configs] = useState<InstalledConfig[]>([]);
  const [selected_key, set_selected_key] = useState("");
  const [loading, set_loading] = useState(true);
  const [config_error, set_config_error] = useState<string | null>(null);
  const [operation_error, set_operation_error] = useState<string | null>(null);
  const [termination, set_termination] = useState("");
  const [result_item, set_result_item] = useState("");
  const [item_query, set_item_query] = useState("");
  const [target_value, set_target_value] = useState("10");
  const [seed, set_seed] = useState("0");
  const [threads, set_threads] = useState("1");
  const [logical_cpu_count, set_logical_cpu_count] = useState(1);
  const [status, set_status] = useState<SimulationStatus>("idle");
  const [stage, set_stage] = useState<SimulationStage | null>(null);
  const [progress, set_progress] = useState<{
    completed: number;
    total: number;
    unit: string;
  } | null>(null);
  const [result_path, set_result_path] = useState("");
  const key = (config: InstalledConfig) => `${config.source}:${config.id}`;
  const selected =
    configs.find((config) => key(config) === selected_key) ?? configs[0];
  const filtered_items = filter_result_items(selected?.items ?? [], item_query);
  const selected_item = selected?.items.find(({ id }) => id === result_item);

  useEffect(() => {
    if (!active) return;
    if (!window.desktopApi) {
      set_config_error("配置扫描 API 不可用，请从 Electron 启动。");
      set_loading(false);
      return;
    }
    set_config_error(null);
    set_loading(true);
    Promise.all([
      window.desktopApi.listConfigs(),
      window.desktopApi.getLogicalCpuCount(),
    ])
      .then(([value, cpu_count]) => {
        set_configs(value);
        set_logical_cpu_count(cpu_count);
        set_selected_key((current) =>
          value.some((config) => key(config) === current)
            ? current
            : value[0]
              ? key(value[0])
              : "",
        );
        set_termination(value[0]?.terminations[0]?.file ?? "");
      })
      .catch(() => set_config_error("配置扫描失败，请检查本地配置目录。"))
      .finally(() => set_loading(false));
  }, [active]);

  useEffect(() => {
    if (!window.desktopApi) return;
    return window.desktopApi.onSimulationEvent(
      ({ status: next_status, event, message }) => {
        set_status(next_status);
        if (event?.type === "started") set_stage("loading_config");
        if (event?.type === "stage") set_stage(event.stage);
        if (event?.type === "progress") set_progress(event);
        if (event?.type === "completed") set_result_path(event.result_path);
        if (message) set_operation_error(message);
      },
    );
  }, []);

  useEffect(() => {
    set_termination(selected?.terminations[0]?.file ?? "");
    set_result_item(default_result_item(selected?.items ?? []));
    set_item_query("");
  }, [selected]);

  const busy = ["starting", "running", "saving", "cancelling"].includes(status);
  const start = async () => {
    set_operation_error(null);
    set_progress(null);
    set_result_path("");
    set_stage("loading_config");
    const canonical_result_item = selected_result_item(
      result_item,
      selected?.items ?? [],
    );
    if (!canonical_result_item) {
      set_status("failed");
      set_operation_error("请选择当前配置中的统计物品 ID");
      return;
    }
    set_result_item(canonical_result_item);
    const request: SimulationRequest = {
      configSource: selected?.source ?? "installed",
      configId: selected?.id ?? "",
      termination,
      resultItem: canonical_result_item,
      target: {
        kind: "totalRuns",
        value: Number(target_value),
      } as SimulationRequest["target"],
      seed: Number(seed),
      threads: Number(threads),
    };
    try {
      validate_simulation_request(request, logical_cpu_count);
      await window.desktopApi.startSimulation(request);
    } catch (reason) {
      set_status("failed");
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const cancel = async () => {
    set_operation_error(null);
    try {
      await window.desktopApi.cancelSimulation();
    } catch (reason) {
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const open_results = async () => {
    try {
      await window.desktopApi.openResultsDirectory();
    } catch (reason) {
      set_operation_error(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };

  const stage_index = {
    loading_config: 0,
    simulating: 1,
    saving: 2,
  }[stage ?? "loading_config"];
  const trace_state = (index: number) => {
    if (status === "completed") return "done";
    if (["failed", "cancelled"].includes(status) && index === stage_index)
      return "failed";
    if (status === "idle" || index > stage_index) return "pending";
    return index < stage_index ? "done" : "active";
  };

  return (
    <section
      hidden={!active}
      className="renderer-placeholder simulation-page"
      aria-labelledby="simulation-title"
    >
      <header className="page-heading">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <Play size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
          <h1 className="page-title" id="simulation-title">
            运行模拟
          </h1>
        </div>
      </header>
      {loading ? (
        <p>正在扫描配置…</p>
      ) : config_error ? (
        <p role="alert">{config_error}</p>
      ) : configs.length === 0 ? (
        <p>暂无可用配置，请先安装官方配置或选择本地配置目录。</p>
      ) : (
        <div className="simulation-workbench">
          <section
            className="instrument-panel simulation-selection"
            data-testid="simulation-selection"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">输入 / INPUT</p>
                <h2 className="panel-title">配置与统计物品</h2>
              </div>
              <code className="panel-id">{selected?.id}</code>
            </div>
            <div className="simulation-config-fields">
              <Field>
                配置
                <select
                  className="field-control"
                  disabled={busy}
                  value={selected ? key(selected) : ""}
                  onChange={(event) => set_selected_key(event.target.value)}
                >
                  {configs.map((config) => (
                    <option key={key(config)} value={key(config)}>
                      {config.source === "installed" ? "官方配置" : "本地配置"}·{" "}
                      {config.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field>
                终止条件
                <select
                  className="field-control"
                  disabled={busy}
                  value={termination}
                  onChange={(event) => set_termination(event.target.value)}
                >
                  {selected?.terminations.map((item) => (
                    <option key={item.file} value={item.file}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <p className="config-description">{selected?.description}</p>
            <div className="item-list-heading">
              <div>
                <span>统计物品</span>
                <small>
                  {filtered_items.length} / {selected?.items.length ?? 0}
                </small>
              </div>
              <label className="item-search">
                <Search aria-hidden="true" size={15} />
                <span className="sr-only">搜索统计物品</span>
                <input
                  autoComplete="off"
                  disabled={busy}
                  placeholder="搜索 ID 或中文名称"
                  type="search"
                  value={item_query}
                  onChange={(event) => set_item_query(event.target.value)}
                />
              </label>
            </div>
            <div
              aria-label="当前配置统计物品"
              className="simulation-item-panel"
              data-testid="simulation-item-list"
              role="radiogroup"
            >
              {filtered_items.map((item) => (
                <label className="simulation-item" key={item.id}>
                  <input
                    checked={result_item === item.id}
                    disabled={busy}
                    name="result-item"
                    type="radio"
                    value={item.id}
                    onChange={() => set_result_item(item.id)}
                  />
                  <span>
                    <strong>{item.name}</strong>
                    <code>{item.id}</code>
                  </span>
                </label>
              ))}
              {filtered_items.length === 0 && (
                <p className="item-empty">没有匹配项，请更换 ID 或名称。</p>
              )}
            </div>
          </section>

          <section className="instrument-panel simulation-control">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">执行 / EXECUTE</p>
                <h2 className="panel-title">运行控制</h2>
              </div>
              <span className="panel-status status-badge" data-status={status}>
                {status_labels[status]}
              </span>
            </div>
            <div className="simulation-control-body">
              <div className="simulation-fields">
                <Field className="target-field">
                  固定次数
                  <input
                    className="field-control"
                    disabled={busy}
                    max={MAX_TOTAL_RUNS}
                    min="1"
                    type="number"
                    value={target_value}
                    onChange={(event) => set_target_value(event.target.value)}
                  />
                </Field>
                <Field>
                  随机种子
                  <input
                    className="field-control"
                    disabled={busy}
                    step="1"
                    type="number"
                    value={seed}
                    onChange={(event) => set_seed(event.target.value)}
                  />
                </Field>
                <Field>
                  线程数{" "}
                  <span className="field-hint">1–{logical_cpu_count}</span>
                  <input
                    className="field-control"
                    disabled={busy}
                    max={logical_cpu_count}
                    min="1"
                    step="1"
                    type="number"
                    value={threads}
                    onChange={(event) => set_threads(event.target.value)}
                  />
                </Field>
              </div>
              <div className="output-item">
                <span>当前输出物品</span>
                <strong>{selected_item?.name ?? "未选择"}</strong>
                <code>{selected_item?.id ?? "—"}</code>
              </div>
              <div className="simulation-actions">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() => void start()}
                >
                  <Play size={16} aria-hidden="true" />
                  启动模拟
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!busy || status === "cancelling"}
                  onClick={() => void cancel()}
                >
                  取消
                </Button>
              </div>
              {operation_error && (
                <div className="simulation-error" role="alert">
                  错误：{operation_error}
                </div>
              )}
              <ol className="simulation-trace" aria-label="模拟任务轨迹">
                {[
                  ["编译配置", "YAML → IR"],
                  [
                    "运行模拟",
                    progress
                      ? `${progress.completed} / ${progress.total} runs`
                      : "等待 core",
                  ],
                  [
                    "保存 GSR",
                    result_path ? result_path.split(/[\\/]/).pop() : "等待写入",
                  ],
                ].map(([label, detail], index) => (
                  <li data-state={trace_state(index)} key={label}>
                    <i aria-hidden="true" />
                    <span>
                      <strong>{label}</strong>
                      <small title={index === 2 ? result_path : undefined}>
                        {detail}
                      </small>
                    </span>
                  </li>
                ))}
              </ol>
              {progress && (
                <progress
                  aria-label="模拟进度"
                  max={progress.total}
                  value={progress.completed}
                />
              )}
              <div className="simulation-status" role="status">
                <span>状态 / {status_labels[status]}</span>
                {result_path && (
                  <Button
                    variant="ghost"
                    size="inline"
                    type="button"
                    onClick={() => void open_results()}
                  >
                    <FolderOpen size={16} aria-hidden="true" />
                    打开结果目录
                  </Button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
