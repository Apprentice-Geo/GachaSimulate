import { WorkbenchIcon } from "../components/WorkbenchIcon";
import { SimulationOrbit } from "../components/SimulationOrbit";
import { ChartColumn, FolderOpen, Play, Search } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import {
  MAX_DESKTOP_THREADS,
  MAX_RUNS,
  type InstalledConfig,
  type SimulationCommandRequest,
  type SimulationStage,
  type SimulationStatus,
} from "../../shared/tauri_desktop_contract";
import type { SimulationStage as OrbitStage } from "../../shared/simulation";
import {
  default_result_item,
  filter_result_items,
  selected_result_item,
} from "../simulation_items";
import { toDesktopError, type TauriDesktopClient } from "../desktop_client";
import type { TauriSimulationController } from "../tauri_simulation_controller";

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

function to_orbit_stage(stage: SimulationStage | null): OrbitStage | null {
  if (stage === "loadingConfig") return "loading_config";
  return stage;
}

export function TauriSimulationPage({
  active,
  client,
  controller,
  result_loading,
  on_view_result,
}: {
  active: boolean;
  client: Pick<
    TauriDesktopClient,
    "listConfigs" | "getLogicalCpuCount" | "openResultsDirectory"
  >;
  controller: TauriSimulationController;
  result_loading: boolean;
  on_view_result: () => Promise<void>;
}) {
  const sim = useSyncExternalStore(
    controller.subscribe,
    controller.get_snapshot,
    controller.get_snapshot,
  );
  const { snapshot } = sim;
  const [configs, set_configs] = useState<InstalledConfig[]>([]);
  const [selected_key, set_selected_key] = useState("");
  const [loading, set_loading] = useState(true);
  const [config_error, set_config_error] = useState<string | null>(null);
  const [action_error, set_action_error] = useState<string | null>(null);
  const [termination, set_termination] = useState("");
  const [result_item, set_result_item] = useState("");
  const [item_query, set_item_query] = useState("");
  const [target_value, set_target_value] = useState("10");
  const [seed, set_seed] = useState("0");
  const [threads, set_threads] = useState("1");
  const [logical_cpu_count, set_logical_cpu_count] = useState(1);

  const key = (config: InstalledConfig) => `${config.source}:${config.id}`;
  const selected =
    configs.find((config) => key(config) === selected_key) ?? configs[0];
  const filtered_items = filter_result_items(selected?.items ?? [], item_query);
  const selected_item = selected?.items.find(({ id }) => id === result_item);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    set_config_error(null);
    set_loading(true);
    Promise.all([
      client.listConfigs(),
      client.getLogicalCpuCount(),
      controller.ensure_connected().catch(() => undefined),
    ])
      .then(([value, cpu_count]) => {
        if (cancelled) return;
        set_configs(value);
        set_logical_cpu_count(cpu_count);
        set_selected_key((current) =>
          value.some((config) => key(config) === current)
            ? current
            : value[0]
              ? key(value[0])
              : "",
        );
      })
      .catch(() => {
        if (!cancelled)
          set_config_error("配置扫描失败，请检查已安装或本地配置目录。");
      })
      .finally(() => {
        if (!cancelled) set_loading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, client, controller]);

  useEffect(() => {
    set_termination((current) =>
      selected?.terminations.some((item) => item.file === current)
        ? current
        : (selected?.terminations[0]?.file ?? ""),
    );
    set_result_item((current) =>
      selected?.items.some((item) => item.id === current)
        ? current
        : default_result_item(selected?.items ?? []),
    );
    set_item_query("");
  }, [selected]);

  const max_threads = Math.min(logical_cpu_count, MAX_DESKTOP_THREADS);
  const effective_status: SimulationStatus = sim.cancellingLocally
    ? "cancelling"
    : sim.startingLocally
      ? "starting"
      : snapshot.status;
  const busy =
    sim.startingLocally ||
    effective_status === "starting" ||
    effective_status === "running" ||
    effective_status === "saving" ||
    effective_status === "cancelling";
  const can_start =
    !busy && !result_loading && !loading && !config_error && Boolean(selected);
  const can_cancel =
    !sim.cancellingLocally &&
    !sim.startingLocally &&
    snapshot.taskId !== null &&
    (snapshot.status === "starting" ||
      snapshot.status === "running" ||
      snapshot.status === "saving" ||
      snapshot.cancelRetryable);
  const progress =
    !sim.startingLocally && snapshot.totalRuns > 0
      ? {
          completed: snapshot.completedRuns,
          total: snapshot.totalRuns,
        }
      : null;
  const displayed_error = action_error ?? sim.error;

  const start = async () => {
    set_action_error(null);
    const canonical_result_item = selected_result_item(
      result_item,
      selected?.items ?? [],
    );
    if (!selected || !canonical_result_item) {
      set_action_error("请选择当前配置中的统计物品 ID");
      return;
    }
    set_result_item(canonical_result_item);
    const request: SimulationCommandRequest = {
      configSource: selected.source,
      configId: selected.id,
      termination,
      resultItem: canonical_result_item,
      totalRuns: Number(target_value),
      seed: Number(seed),
      threads: Number(threads),
    };
    await controller.start(request, max_threads);
  };

  const cancel = async () => {
    set_action_error(null);
    await controller.cancel();
  };

  const result_action = async (action: () => Promise<void>) => {
    set_action_error(null);
    try {
      await action();
    } catch (reason) {
      set_action_error(toDesktopError(reason).message);
    }
  };

  return (
    <section
      hidden={!active}
      className="renderer-placeholder simulation-page"
      aria-labelledby="simulation-title"
    >
      <header className="page-heading">
        <div className="renderer-placeholder-mark" aria-hidden="true">
          <WorkbenchIcon icon={Play} size={20} />
        </div>
        <div>
          <p className="renderer-eyebrow">SIMULATION CONSOLE</p>
          <h1 className="page-title" id="simulation-title">
            运行模拟
          </h1>
        </div>
      </header>
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
            <code className="panel-id">{selected?.id ?? "—"}</code>
          </div>
          {loading ? (
            <p>正在扫描配置…</p>
          ) : config_error ? (
            <p className="simulation-error" role="alert">
              {config_error}
            </p>
          ) : configs.length === 0 ? (
            <p>暂无可用配置，请先安装官方配置或选择本地配置目录。</p>
          ) : (
            <>
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
                        {config.source === "installed"
                          ? "官方配置"
                          : "本地配置"}
                        · {config.name}
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
                  <WorkbenchIcon icon={Search} aria-hidden="true" size={15} />
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
                className="simulation-item-panel workbench-scroll-region"
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
            </>
          )}
        </section>

        <section className="instrument-panel simulation-control">
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">执行 / EXECUTE</p>
              <h2 className="panel-title">运行控制</h2>
            </div>
            <span
              className="panel-status status-badge"
              data-status={effective_status}
            >
              {status_labels[effective_status]}
            </span>
          </div>
          <div className="simulation-control-body workbench-scroll-region">
            <div className="simulation-fields">
              <Field className="target-field">
                固定次数
                <input
                  className="field-control"
                  disabled={busy}
                  max={MAX_RUNS}
                  min="1"
                  type="number"
                  value={target_value}
                  onChange={(event) => set_target_value(event.target.value)}
                />
              </Field>
              <Field>
                <span className="field-heading">
                  <span>随机种子</span>
                  <span className="field-hint">整数</span>
                </span>
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
                <span className="field-heading">
                  <span>线程数</span>
                  <span className="field-hint">1–{max_threads}</span>
                </span>
                <input
                  className="field-control"
                  disabled={busy}
                  max={max_threads}
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
                disabled={!can_start}
                onClick={() => void start()}
              >
                <WorkbenchIcon icon={Play} size={16} aria-hidden="true" />
                {sim.startingLocally ? "正在启动…" : "启动模拟"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!can_cancel}
                onClick={() => void cancel()}
              >
                {effective_status === "cancelling" && snapshot.cancelRetryable
                  ? "重试取消"
                  : "取消"}
              </Button>
            </div>
            {displayed_error && (
              <div className="simulation-error" role="alert">
                错误：{displayed_error}
              </div>
            )}
            <SimulationOrbit
              status={effective_status}
              stage={to_orbit_stage(snapshot.stage)}
              progress={progress}
              active={active}
            />
            <div className="simulation-status">
              <span role="status">
                状态 / {status_labels[effective_status]}
              </span>
              {effective_status === "completed" && (
                <div className="simulation-result-actions">
                  <Button
                    variant="link"
                    size="inline"
                    disabled={result_loading}
                    onClick={() => void result_action(on_view_result)}
                  >
                    <WorkbenchIcon
                      icon={ChartColumn}
                      size={16}
                      aria-hidden="true"
                    />
                    {result_loading ? "正在载入…" : "查看本次结果"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="inline"
                    type="button"
                    onClick={() =>
                      void result_action(() => client.openResultsDirectory())
                    }
                  >
                    <WorkbenchIcon
                      icon={FolderOpen}
                      size={16}
                      aria-hidden="true"
                    />
                    打开结果目录
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
