import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use_page_scale } from "./hooks/use_page_scale";
import { ANIMATION_TOTAL_MS } from "./animation/timeline";
import { build_animation_progress } from "./animation/progress";
import { VisualizeScene } from "./VisualizeScene";
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

export default function App() {
  const [state, set_state] = useState<AppState>({ status: "idle" });
  const [animation_elapsed_ms, set_animation_elapsed_ms] =
    useState(ANIMATION_TOTAL_MS);
  const [is_animating, set_is_animating] = useState(false);
  const [is_animation_primed, set_is_animation_primed] = useState(false);
  const animation_frame_ref = useRef<number | null>(null);
  const skip_initial_autoplay_ref = useRef(
    new URLSearchParams(window.location.search).get("autoplay") === "0",
  );
  const first_ready_seen_ref = useRef(false);

  use_page_scale();

  const start_animation = useCallback(() => {
    if (animation_frame_ref.current !== null) {
      window.cancelAnimationFrame(animation_frame_ref.current);
    }

    set_is_animation_primed(false);
    set_is_animating(true);
    set_animation_elapsed_ms(0);

    const started_at = performance.now();
    const tick = (now: number) => {
      const elapsed_ms = Math.min(ANIMATION_TOTAL_MS, now - started_at);
      set_animation_elapsed_ms(elapsed_ms);

      if (elapsed_ms >= ANIMATION_TOTAL_MS) {
        set_is_animating(false);
        animation_frame_ref.current = null;
        return;
      }

      animation_frame_ref.current = window.requestAnimationFrame(tick);
    };

    animation_frame_ref.current = window.requestAnimationFrame(tick);
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
          set_animation_elapsed_ms(0);
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
      if (animation_frame_ref.current !== null) {
        window.cancelAnimationFrame(animation_frame_ref.current);
      }
    };
  }, []);

  const data = useMemo(
    () =>
      state.status === "ready" ? build_visualize_view_model(state.data) : null,
    [state],
  );
  const animation_progress = useMemo(
    () => build_animation_progress(animation_elapsed_ms),
    [animation_elapsed_ms],
  );
  const animation_state = is_animating
    ? "playing"
    : is_animation_primed
      ? "primed"
      : "idle";

  if (state.status === "ready" && data) {
    return (
      <VisualizeScene
        animation_progress={animation_progress}
        animation_state={animation_state}
        data={data}
        is_animating={is_animating}
        on_file_import={handle_file_import}
        on_replay={start_animation}
      />
    );
  }

  return (
    <main
      className="visualize-page"
      data-testid="visualize-root"
      data-load-state={state.status}
      data-animation-state={animation_state}
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
          </div>
          <TerminationBar
            data={data}
            animation_progress={null}
            is_ready={state.status === "ready"}
          />
        </div>
        <StatisticPanel
          data={data}
          animation_progress={null}
          is_ready={state.status === "ready"}
        />
      </section>

      {data?.note && <p className="page-note">{data.note}</p>}
    </main>
  );
}
