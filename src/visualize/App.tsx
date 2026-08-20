import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use_page_scale } from "./hooks/use_page_scale";
import { ANIMATION_TOTAL_MS } from "./animation/timeline";
import { build_animation_progress } from "./animation/progress";
import { VisualizeScene } from "./VisualizeScene";
import { VisualizeShell } from "./components/VisualizeShell";
import { EmptyState } from "./components/EmptyState";
import { ErrorState } from "./components/ErrorState";
import { LoadingState } from "./components/LoadingState";
import type { CDFViewModel } from "./types/cdf";

function get_error_message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function App({
  input,
  on_select_result,
}: {
  input: CDFViewModel | null;
  on_select_result: () => Promise<boolean>;
}) {
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [animation_elapsed_ms, set_animation_elapsed_ms] =
    useState(ANIMATION_TOTAL_MS);
  const [is_animating, set_is_animating] = useState(false);
  const animation_frame_ref = useRef<number | null>(null);
  const viewport_ref = useRef<HTMLDivElement>(null);

  use_page_scale(viewport_ref);

  const start_animation = useCallback(() => {
    if (animation_frame_ref.current !== null) {
      window.cancelAnimationFrame(animation_frame_ref.current);
    }

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

  const handle_desktop_file_select = useCallback(async () => {
    set_loading(true);
    set_error(null);
    try {
      await on_select_result();
    } catch (error) {
      set_error(get_error_message(error));
    } finally {
      set_loading(false);
    }
  }, [on_select_result]);

  useEffect(() => {
    if (input) start_animation();
  }, [input, start_animation]);

  const load_state = error
    ? "error"
    : loading
      ? "loading"
      : input
        ? "ready"
        : "idle";

  useEffect(() => {
    document.documentElement.dataset.visualizeState = load_state;
    document.documentElement.dataset.visualizeAnimation = is_animating
      ? "playing"
      : "idle";
  }, [is_animating, load_state]);

  useEffect(() => {
    return () => {
      if (animation_frame_ref.current !== null) {
        window.cancelAnimationFrame(animation_frame_ref.current);
      }
    };
  }, []);

  const data = input;
  const animation_progress = useMemo(
    () => build_animation_progress(animation_elapsed_ms),
    [animation_elapsed_ms],
  );
  const animation_state = is_animating ? "playing" : "idle";

  return (
    <div className="visualize-viewport" ref={viewport_ref}>
      {load_state === "ready" && data ? (
        <VisualizeScene
          animation_progress={animation_progress}
          animation_state={animation_state}
          data={data}
          is_animating={is_animating}
          on_select_file={() => void handle_desktop_file_select()}
          on_replay={start_animation}
        />
      ) : (
        <VisualizeShell
          animation_progress={null}
          animation_state={animation_state}
          chart_slot={
            <>
              {load_state === "idle" && <EmptyState />}
              {load_state === "loading" && <LoadingState />}
              {load_state === "error" && error && (
                <ErrorState message={error} />
              )}
            </>
          }
          data={data}
          is_animating={is_animating}
          load_state={load_state}
          on_select_file={() => void handle_desktop_file_select()}
          on_replay={start_animation}
        />
      )}
    </div>
  );
}
