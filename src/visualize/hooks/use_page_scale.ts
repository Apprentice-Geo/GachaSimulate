import { useLayoutEffect, type RefObject } from "react";
import { CANVAS_HEIGHT, CANVAS_WIDTH } from "../constants";

function update_scale(viewport: HTMLElement) {
  const viewport_rect = viewport.getBoundingClientRect();
  const viewport_style = getComputedStyle(viewport);
  const horizontal_inset =
    Number.parseFloat(viewport_style.borderLeftWidth) +
    Number.parseFloat(viewport_style.borderRightWidth) +
    Number.parseFloat(viewport_style.paddingLeft) +
    Number.parseFloat(viewport_style.paddingRight);
  const vertical_inset =
    Number.parseFloat(viewport_style.borderTopWidth) +
    Number.parseFloat(viewport_style.borderBottomWidth) +
    Number.parseFloat(viewport_style.paddingTop) +
    Number.parseFloat(viewport_style.paddingBottom);
  const available_width = viewport_rect.width - horizontal_inset;
  const available_height = viewport_rect.height - vertical_inset;
  if (available_width <= 0 || available_height <= 0) return;
  const available_scale = Math.min(
    available_width / CANVAS_WIDTH,
    available_height / CANVAS_HEIGHT,
    1.0,
  );
  // Keep the 16:9 canvas dimensions on Chromium layout-unit boundaries after
  // zoom, while always rounding inward so fractional hosts cannot overflow.
  const scale_steps = CANVAS_WIDTH * 4;
  const scale = Math.floor(available_scale * scale_steps) / scale_steps;
  viewport.style.setProperty("--page-scale", String(scale));
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
