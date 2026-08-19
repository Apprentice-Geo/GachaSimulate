import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use_page_scale } from "./hooks/use_page_scale";
import { ANIMATION_TOTAL_MS } from "./animation/timeline";
import { build_animation_progress } from "./animation/progress";
import { VisualizeScene } from "./VisualizeScene";
import { VisualizeShell } from "./components/VisualizeShell";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { LoadingState } from "./components/LoadingState";
import {
  get_input_path_from_url,
  load_input_from_file,
  load_input_from_project_path,
} from "./data/load_input";
import type { NormalizedVisualizeData } from "./types/visualize_input";
import { build_visualize_view_model } from "./view/cdf_view_model";

type AppState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: NormalizedVisualizeData };

function get_error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App({
  input,
  on_select_result,
}: {
  input?: NormalizedVisualizeData | null;
  on_select_result?: () => Promise<boolean>;
}) {
  const external = input !== undefined;
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
  const viewport_ref = useRef<HTMLDivElement>(null);

  use_page_scale(viewport_ref);

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
      const input = await load_input_from_project_path(input_path);
      set_state({
        status: "ready",
        data: build_visualize_view_model(input),
      });
    } catch (error) {
      set_state({ status: "error", message: get_error_message(error) });
    }
  }, []);

  const handle_file_import = useCallback(async (file: File) => {
    set_state({ status: "loading" });
    try {
      const input = await load_input_from_file(file);
      set_state({
        status: "ready",
        data: build_visualize_view_model(input),
      });
    } catch (error) {
      set_state({ status: "error", message: get_error_message(error) });
    }
  }, []);

  const handle_desktop_file_select = useCallback(async () => {
    if (!on_select_result) return;
    set_state({ status: "loading" });
    try {
      const selected = await on_select_result();
      if (!selected) {
        set_state(
          input ? { status: "ready", data: input } : { status: "idle" },
        );
      }
    } catch (error) {
      set_state({ status: "error", message: get_error_message(error) });
    }
  }, [input, on_select_result]);

  useEffect(() => {
    if (!external) return;
    if (!input) {
      set_state({ status: "idle" });
      return;
    }
    set_state({ status: "ready", data: input });
  }, [external, input]);

  useEffect(() => {
    if (external) return;
    const input_path = get_input_path_from_url();
    if (input_path) {
      void load_project_input(input_path);
    }
  }, [external, load_project_input]);

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

  const data = state.status === "ready" ? state.data : null;
  const animation_progress = useMemo(
    () => build_animation_progress(animation_elapsed_ms),
    [animation_elapsed_ms],
  );
  const animation_state = is_animating
    ? "playing"
    : is_animation_primed
      ? "primed"
      : "idle";

  return (
    <div className="visualize-viewport" ref={viewport_ref}>
      {state.status === "ready" && data ? (
        <VisualizeScene
          animation_progress={animation_progress}
          animation_state={animation_state}
          data={data}
          is_animating={is_animating}
          on_file_import={external ? undefined : handle_file_import}
          on_select_file={
            on_select_result
              ? () => void handle_desktop_file_select()
              : undefined
          }
          on_replay={start_animation}
        />
      ) : (
        <VisualizeShell
          animation_progress={null}
          animation_state={animation_state}
          chart_slot={
            <>
              {state.status === "idle" && <EmptyState desktop={external} />}
              {state.status === "loading" && <LoadingState />}
              {state.status === "error" && (
                <ErrorState
                  message={state.message}
                  on_file_import={external ? undefined : handle_file_import}
                />
              )}
            </>
          }
          data={data}
          is_animating={is_animating}
          load_state={state.status}
          on_file_import={external ? undefined : handle_file_import}
          on_select_file={
            on_select_result
              ? () => void handle_desktop_file_select()
              : undefined
          }
          on_replay={start_animation}
        />
      )}
    </div>
  );
}
