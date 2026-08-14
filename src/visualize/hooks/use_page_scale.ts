import { useLayoutEffect, type RefObject } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";

function update_scale(viewport: HTMLElement) {
  if (viewport.clientWidth === 0 || viewport.clientHeight === 0) return;
  const scale = Math.min(
    viewport.clientWidth / CANVAS_WIDTH,
    viewport.clientHeight / CANVAS_HEIGHT,
    1.0,
  );
  document.documentElement.style.setProperty("--page-scale", String(scale));
}

export function use_page_scale(viewport_ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const viewport = viewport_ref.current;
    if (!viewport) return;

    let device_pixel_ratio = window.devicePixelRatio;
    update_scale(viewport);
    const resize = () => {
      // Browser zoom changes DPR; keep the user-selected zoom until the window itself changes.
      if (window.devicePixelRatio !== device_pixel_ratio) {
        device_pixel_ratio = window.devicePixelRatio;
        return;
      }
      update_scale(viewport);
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [viewport_ref]);
}
