import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use_page_scale } from "./hooks/use_page_scale";
import { ANIMATION_TOTAL_MS } from "./animation/timeline";
import { build_animation_progress } from "./animation/progress";
import { VisualizeScene } from "./VisualizeScene";
import type { CDFViewModel } from "./types/cdf";

export default function App({
  input,
  on_select_result,
  on_export,
  export_active = false,
  export_available = false,
}: {
  input: CDFViewModel;
  on_select_result: () => Promise<boolean>;
  on_export?: () => void;
  export_active?: boolean;
  export_available?: boolean;
}) {
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
    await on_select_result();
  }, [on_select_result]);

  useEffect(() => {
    if (input) start_animation();
  }, [input, start_animation]);

  useEffect(() => {
    document.documentElement.dataset.visualizeState = "ready";
    document.documentElement.dataset.visualizeAnimation = is_animating
      ? "playing"
      : "idle";
  }, [is_animating]);

  useEffect(() => {
    return () => {
      if (animation_frame_ref.current !== null) {
        window.cancelAnimationFrame(animation_frame_ref.current);
      }
    };
  }, []);

  const animation_progress = useMemo(
    () => build_animation_progress(animation_elapsed_ms),
    [animation_elapsed_ms],
  );
  const animation_state = is_animating ? "playing" : "idle";
  const export_disabled_reason = export_active
    ? "已有导出流程正在进行。"
    : !export_available
      ? "请先载入结果后再导出。"
      : undefined;

  return (
    <div className="visualize-scope visualize-viewport" ref={viewport_ref}>
      <VisualizeScene
        animation_progress={animation_progress}
        animation_state={animation_state}
        data={input}
        is_animating={is_animating}
        on_select_file={() => void handle_desktop_file_select()}
        on_replay={start_animation}
        on_export={on_export}
        export_disabled_reason={export_disabled_reason}
        render_mode="interactive"
      />
    </div>
  );
}
