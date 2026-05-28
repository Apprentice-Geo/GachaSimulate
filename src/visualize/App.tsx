import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANIMATION_TIMELINE, ANIMATION_TOTAL_MS } from "./animation/timeline";
import { CDFChart } from "./components/CDFChart";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { LoadingState } from "./components/LoadingState";
import { StatisticPanel } from "./components/StatisticPanel";
import { TerminationBar } from "./components/TerminationBar";
import { TopBar } from "./components/TopBar";
import {
  get_input_path_from_url,
  load_input_from_file,
  load_input_from_project_path,
} from "./data/load_input";
import type { NormalizedVisualizeInputData } from "./types/visualize_input";
import { build_visualize_view_model } from "./view/cdf_view_model";

type AppState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NormalizedVisualizeInputData };

function get_error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ANIMATION_TIMELINE_STYLE = {
  "--animation-top-bar-delay": `${ANIMATION_TIMELINE.TOP_BAR_DELAY_MS}ms`,
  "--animation-top-bar-duration": `${ANIMATION_TIMELINE.TOP_BAR_DURATION_MS}ms`,
  "--animation-chart-shell-delay": `${ANIMATION_TIMELINE.CHART_SHELL_DELAY_MS}ms`,
  "--animation-chart-shell-duration": `${ANIMATION_TIMELINE.CHART_SHELL_DURATION_MS}ms`,
  "--animation-chart-surface-delay": `${ANIMATION_TIMELINE.CHART_SURFACE_DELAY_MS}ms`,
  "--animation-chart-surface-duration": `${ANIMATION_TIMELINE.CHART_SURFACE_DURATION_MS}ms`,
  "--animation-curve-delay": `${ANIMATION_TIMELINE.CURVE_DELAY_MS}ms`,
  "--animation-curve-duration": `${ANIMATION_TIMELINE.CURVE_DURATION_MS}ms`,
  "--animation-marker-line-delay": `${ANIMATION_TIMELINE.MARKER_LINE_DELAY_MS}ms`,
  "--animation-marker-line-duration": `${ANIMATION_TIMELINE.MARKER_LINE_DURATION_MS}ms`,
  "--animation-marker-group-delay": `${ANIMATION_TIMELINE.MARKER_GROUP_DELAY_MS}ms`,
  "--animation-marker-group-duration": `${ANIMATION_TIMELINE.MARKER_GROUP_DURATION_MS}ms`,
  "--animation-marker-stagger": `${ANIMATION_TIMELINE.MARKER_STAGGER_MS}ms`,
  "--animation-mean-line-delay": `${ANIMATION_TIMELINE.MEAN_LINE_DELAY_MS}ms`,
  "--animation-mean-line-duration": `${ANIMATION_TIMELINE.MEAN_LINE_DURATION_MS}ms`,
  "--animation-termination-panel-delay": `${ANIMATION_TIMELINE.TERMINATION_PANEL_DELAY_MS}ms`,
  "--animation-termination-panel-duration": `${ANIMATION_TIMELINE.TERMINATION_PANEL_DURATION_MS}ms`,
  "--animation-pk-fill-delay": `${ANIMATION_TIMELINE.PK_FILL_DELAY_MS}ms`,
  "--animation-pk-fill-duration": `${ANIMATION_TIMELINE.PK_FILL_DURATION_MS}ms`,
  "--animation-termination-detail-delay": `${ANIMATION_TIMELINE.TERMINATION_DETAIL_DELAY_MS}ms`,
  "--animation-termination-detail-duration": `${ANIMATION_TIMELINE.TERMINATION_DETAIL_DURATION_MS}ms`,
  "--animation-stat-panel-delay": `${ANIMATION_TIMELINE.STAT_PANEL_DELAY_MS}ms`,
  "--animation-stat-panel-duration": `${ANIMATION_TIMELINE.STAT_PANEL_DURATION_MS}ms`,
  "--animation-stat-content-delay": `${ANIMATION_TIMELINE.STAT_CONTENT_DELAY_MS}ms`,
  "--animation-stat-content-duration": `${ANIMATION_TIMELINE.STAT_CONTENT_DURATION_MS}ms`,
  "--animation-stat-content-stagger": `${ANIMATION_TIMELINE.STAT_CONTENT_STAGGER_MS}ms`,
  "--animation-note-delay": `${ANIMATION_TIMELINE.NOTE_DELAY_MS}ms`,
  "--animation-note-duration": `${ANIMATION_TIMELINE.NOTE_DURATION_MS}ms`,
} as CSSProperties;

export default function App() {
  const [state, set_state] = useState<AppState>({ status: "idle" });
  const [animation_key, set_animation_key] = useState(0);
  const [is_animating, set_is_animating] = useState(false);
  const [is_animation_primed, set_is_animation_primed] = useState(false);
  const animation_timeout_ref = useRef<number | null>(null);
  const skip_initial_autoplay_ref = useRef(
    new URLSearchParams(window.location.search).get("autoplay") === "0",
  );
  const first_ready_seen_ref = useRef(false);

  const start_animation = useCallback(() => {
    if (animation_timeout_ref.current !== null) {
      window.clearTimeout(animation_timeout_ref.current);
    }

    set_animation_key((current_key) => current_key + 1);
    set_is_animation_primed(false);
    set_is_animating(true);
    animation_timeout_ref.current = window.setTimeout(() => {
      set_is_animating(false);
      animation_timeout_ref.current = null;
    }, ANIMATION_TOTAL_MS);
  }, []);

  const load_project_input = useCallback(async (input_path: string) => {
    set_state({ status: "loading" });
    try {
      const data = await load_input_from_project_path(input_path);
      set_state({ status: "ready", data });
    } catch (error) {
      set_state({ status: "error", message: get_error_message(error) });
    }
  }, []);

  const handle_file_import = useCallback(async (file: File) => {
    set_state({ status: "loading" });
    try {
      const data = await load_input_from_file(file);
      set_state({ status: "ready", data });
    } catch (error) {
      set_state({ status: "error", message: get_error_message(error) });
    }
  }, []);

  useEffect(() => {
    const input_path = get_input_path_from_url();
    if (input_path) {
      void load_project_input(input_path);
    }
  }, [load_project_input]);

  useEffect(() => {
    if (state.status === "ready") {
      if (skip_initial_autoplay_ref.current) {
        if (!first_ready_seen_ref.current) {
          first_ready_seen_ref.current = true;
          set_is_animation_primed(true);
        }
        return;
      }

      if (!first_ready_seen_ref.current) {
        first_ready_seen_ref.current = true;
      }
      start_animation();
    }
  }, [state, start_animation]);

  useEffect(() => {
    document.documentElement.dataset.visualizeState = state.status;
    document.documentElement.dataset.visualizeAnimation = is_animating
      ? "playing"
      : is_animation_primed
        ? "primed"
        : "idle";
  }, [is_animating, is_animation_primed, state.status]);

  useEffect(() => {
    return () => {
      if (animation_timeout_ref.current !== null) {
        window.clearTimeout(animation_timeout_ref.current);
      }
    };
  }, []);

  const data = useMemo(
    () =>
      state.status === "ready" ? build_visualize_view_model(state.data) : null,
    [state],
  );

  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state={state.status}
      data-animation-state={
        is_animating ? "playing" : is_animation_primed ? "primed" : "idle"
      }
      style={ANIMATION_TIMELINE_STYLE}
    >
      <TopBar
        data={data}
        is_animating={is_animating}
        on_file_import={handle_file_import}
        on_replay={start_animation}
      />

      <section className="main-region" aria-label="CDF 可视化主体">
        <div className="primary-region">
          <div className="chart-region">
            {state.status === "idle" && <EmptyState />}
            {state.status === "loading" && <LoadingState />}
            {state.status === "error" && (
              <ErrorState
                message={state.message}
                on_file_import={handle_file_import}
              />
            )}
            {state.status === "ready" && data && (
              <CDFChart
                data={data}
                animation_key={animation_key}
                is_animating={is_animating}
              />
            )}
          </div>
          <TerminationBar
            data={data}
            animation_key={animation_key}
            is_ready={state.status === "ready"}
          />
        </div>
        <StatisticPanel
          data={data}
          animation_key={animation_key}
          is_ready={state.status === "ready"}
        />
      </section>

      {data?.note && <p className="page-note">{data.note}</p>}
    </main>
  );
}
