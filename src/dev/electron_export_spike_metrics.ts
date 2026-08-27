export interface BackendAggregate {
  backend: "capture-page" | "cdp";
  correct: boolean;
  screenshot_total_ms: number[];
  ffmpeg_total_ms: number[];
  ui_probe_ms: number[];
  main_loop_delay_ms: number[];
}

export interface SpikeThresholds {
  screenshot_total_ms: number;
  ffmpeg_total_ms: number;
  response_p95_ms: number;
  response_max_ms: number;
}

export interface BackendDecision {
  backend: "capture-page" | "cdp" | null;
  reason: string;
}

export function percentile(
  values: readonly number[],
  quantile: number,
): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(quantile * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function backend_qualifies(
  result: BackendAggregate,
  thresholds: SpikeThresholds,
): boolean {
  const response = [...result.ui_probe_ms, ...result.main_loop_delay_ms];
  return (
    result.correct &&
    result.screenshot_total_ms.length > 0 &&
    result.ffmpeg_total_ms.length > 0 &&
    result.screenshot_total_ms.every(
      (value) => value <= thresholds.screenshot_total_ms,
    ) &&
    result.ffmpeg_total_ms.every(
      (value) => value <= thresholds.ffmpeg_total_ms,
    ) &&
    percentile(response, 0.95) <= thresholds.response_p95_ms &&
    Math.max(0, ...response) <= thresholds.response_max_ms
  );
}

export function select_backend(
  results: readonly BackendAggregate[],
  thresholds: SpikeThresholds,
): BackendDecision {
  const qualified = results.filter((result) =>
    backend_qualifies(result, thresholds),
  );
  if (qualified.length === 0) {
    return { backend: null, reason: "no backend passed every hard threshold" };
  }
  if (qualified.length === 1) {
    return {
      backend: qualified[0].backend,
      reason: "only backend that passed every hard threshold",
    };
  }

  const [capture_page, cdp] = [
    qualified.find(({ backend }) => backend === "capture-page")!,
    qualified.find(({ backend }) => backend === "cdp")!,
  ];
  const capture_total = median(capture_page.screenshot_total_ms);
  const cdp_total = median(cdp.screenshot_total_ms);
  const relative_difference =
    Math.abs(capture_total - cdp_total) / Math.max(capture_total, cdp_total);
  if (relative_difference >= 0.1) {
    return capture_total < cdp_total
      ? {
          backend: "capture-page",
          reason: "screenshot median was at least 10% faster",
        }
      : { backend: "cdp", reason: "screenshot median was at least 10% faster" };
  }

  const capture_response = percentile(
    [...capture_page.ui_probe_ms, ...capture_page.main_loop_delay_ms],
    0.95,
  );
  const cdp_response = percentile(
    [...cdp.ui_probe_ms, ...cdp.main_loop_delay_ms],
    0.95,
  );
  if (Math.abs(capture_response - cdp_response) >= 20) {
    return capture_response < cdp_response
      ? {
          backend: "capture-page",
          reason: "response P95 was at least 20 ms lower",
        }
      : { backend: "cdp", reason: "response P95 was at least 20 ms lower" };
  }
  return {
    backend: "capture-page",
    reason:
      "performance was equivalent; prefer the simpler public Electron API",
  };
}
