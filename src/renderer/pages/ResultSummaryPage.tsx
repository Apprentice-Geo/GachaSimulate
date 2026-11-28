import { FileSpreadsheet, FolderOpen } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/Button";
import { ResultLoadPanel } from "../components/ResultLoadPanel";
import { WorkbenchIcon } from "../components/WorkbenchIcon";
import { get_statistic_description } from "../../visualize/view/statistic_view_config";
import type { TauriResultSessionState } from "../tauri_result_session_controller";
import { toDesktopError } from "../desktop_client";

const KEY_METRIC_ORDER = ["P50", "MEAN", "P95"] as const;
const INDEX_METRIC_ORDER = ["MIN", "P5", "P25", "P75", "MAX"] as const;

/**
 * Milestone 2 result summary view: verifies exact full-integer readings and
 * confirmed result switching while keeping Milestone 3 visualization, inline
 * editing, and export entry points hidden.
 */
export function ResultSummaryPage({
  session,
  on_select_result,
  on_open_results_directory,
}: {
  session: TauriResultSessionState;
  on_select_result: () => Promise<boolean>;
  on_open_results_directory: () => Promise<void>;
}) {
  const [directory_error, set_directory_error] = useState<string | null>(null);
  const { result, model, loading, load_error, load_status } = session;

  const open_directory = async () => {
    set_directory_error(null);
    try {
      await on_open_results_directory();
    } catch (reason) {
      set_directory_error(toDesktopError(reason).message);
    }
  };

  if (!result || !model) {
    return (
      <section className="renderer-placeholder result-load-page">
        <ResultLoadPanel
          description="选择 GSR 结果文件并完成分析后，可在此核对完整统计读数、累计总量与终止原因分布。"
          loading={loading}
          error={load_error}
          status={load_status}
          on_select={() => void on_select_result()}
        />
      </section>
    );
  }

  const metric_by_key = new Map(
    model.metrics.map((metric) => [metric.key, metric]),
  );

  return (
    <section
      className="renderer-placeholder result-summary-page"
      aria-labelledby="result-summary-title"
    >
      <header className="page-heading result-summary-header">
        <div className="result-summary-heading-left">
          <div className="renderer-placeholder-mark" aria-hidden="true">
            <WorkbenchIcon icon={FileSpreadsheet} size={20} />
          </div>
          <div>
            <p className="renderer-eyebrow">RESULT SUMMARY</p>
            <h1 className="page-title" id="result-summary-title">
              结果摘要
            </h1>
          </div>
        </div>
        <div className="result-summary-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => void on_select_result()}
          >
            {loading ? "正在分析…" : "更换结果"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void open_directory()}
          >
            <WorkbenchIcon icon={FolderOpen} size={16} aria-hidden="true" />
            打开结果目录
          </Button>
        </div>
      </header>

      {(load_error || directory_error) && (
        <div className="simulation-error" role="alert">
          错误：{load_error ?? directory_error}
        </div>
      )}
      {!load_error && load_status && (
        <p className="result-load-status" role="status">
          {load_status}
        </p>
      )}

      <div className="result-summary-body workbench-scroll-region">
        <section
          className="instrument-panel result-summary-panel"
          aria-labelledby="summary-overview-title"
        >
          <div className="panel-heading">
            <div>
              <p className="panel-kicker">OVERVIEW</p>
              <h2 className="panel-title" id="summary-overview-title">
                结果概览
              </h2>
            </div>
            <code className="panel-id" data-testid="summary-filename">
              {result.filename}
            </code>
          </div>
          <dl className="result-summary-overview-grid">
            <div>
              <dt>统计物品</dt>
              <dd data-testid="summary-result-item">
                <span>{model.result_item.name}</span>
                <code>{model.result_item.id}</code>
              </dd>
            </div>
            <div>
              <dt>累计模拟次数</dt>
              <dd className="summary-mono" data-testid="summary-total-runs">
                {model.runs_text}
              </dd>
            </div>
            <div>
              <dt>累计结果</dt>
              <dd className="summary-mono" data-testid="summary-total-result">
                {model.total_result_display}
              </dd>
            </div>
            <div>
              <dt>分布离散点数</dt>
              <dd className="summary-mono" data-testid="summary-point-count">
                {model.chart_points.length}
              </dd>
            </div>
          </dl>
        </section>

        <div className="result-summary-columns">
          <section
            className="instrument-panel result-summary-panel"
            aria-labelledby="summary-metrics-title"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">STATISTICS</p>
                <h2 className="panel-title" id="summary-metrics-title">
                  统计指标
                </h2>
              </div>
              <span className="panel-id">精确整数读数</span>
            </div>
            <div className="result-summary-key-metrics">
              {KEY_METRIC_ORDER.map((key) => {
                const metric = metric_by_key.get(key)!;
                return (
                  <div
                    className="result-summary-metric-card"
                    data-testid={`summary-metric-${key}`}
                    key={key}
                  >
                    <div className="result-summary-metric-head">
                      <strong>{metric.label}</strong>
                      <span>{get_statistic_description(key)}</span>
                    </div>
                    <p className="summary-mono result-summary-metric-value">
                      {metric.display_value}
                    </p>
                  </div>
                );
              })}
            </div>
            <dl className="result-summary-index-list">
              {INDEX_METRIC_ORDER.map((key) => {
                const metric = metric_by_key.get(key)!;
                return (
                  <div key={key} data-testid={`summary-metric-${key}`}>
                    <dt>
                      <strong>{metric.label}</strong>
                      <span>{get_statistic_description(key)}</span>
                    </dt>
                    <dd className="summary-mono">{metric.display_value}</dd>
                  </div>
                );
              })}
            </dl>
          </section>

          <section
            className="instrument-panel result-summary-panel"
            aria-labelledby="summary-reasons-title"
          >
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">TERMINATION</p>
                <h2 className="panel-title" id="summary-reasons-title">
                  终止原因分布
                </h2>
              </div>
              <span className="panel-id">
                {model.termination_reason.length} 项
              </span>
            </div>
            <ul className="result-summary-reasons">
              {model.termination_reason.map((entry) => (
                <li key={entry.reason}>
                  <span>{entry.reason}</span>
                  <strong className="summary-mono">{entry.proportion}%</strong>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </section>
  );
}
