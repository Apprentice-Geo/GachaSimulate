import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { use_page_scale } from "./hooks/use_page_scale";
import { ANIMATION_TOTAL_MS } from "./animation/timeline";
import { build_animation_progress } from "./animation/progress";
import { VisualizeScene } from "./VisualizeScene";
import type { CDFViewModel } from "./types/cdf";

export default function App({
  input,
  render_controls,
}: {
  input: CDFViewModel;
  render_controls: (controls: {
    replay: () => void;
    is_animating: boolean;
  }) => ReactNode;
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
  return (
    <>
      {render_controls({ replay: start_animation, is_animating })}
      <div className="visualize-scope visualize-viewport" ref={viewport_ref}>
        <VisualizeScene
          animation_progress={animation_progress}
          animation_state={animation_state}
          data={input}
          render_mode="interactive"
        />
      </div>
    </>
  );
}
