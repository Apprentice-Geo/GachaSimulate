import { useLayoutEffect } from "react";

const CANVAS_WIDTH = 3840;
const CANVAS_HEIGHT = 2160;

function update_scale() {
  const scale = Math.min(
    window.innerWidth / CANVAS_WIDTH,
    window.innerHeight / CANVAS_HEIGHT,
    1.0,
  );
  const clamped = Math.max(0.1, scale);
  const offset_x = (window.innerWidth - CANVAS_WIDTH * clamped) / 2;
  const offset_y = (window.innerHeight - CANVAS_HEIGHT * clamped) / 2;
  const root = document.documentElement.style;
  root.setProperty("--page-scale", String(clamped));
  root.setProperty("--page-offset-x", `${offset_x}px`);
  root.setProperty("--page-offset-y", `${offset_y}px`);
}

export function use_page_scale() {
  useLayoutEffect(() => {
    update_scale();
    window.addEventListener("resize", update_scale);
    return () => {
      window.removeEventListener("resize", update_scale);
    };
  }, []);
}
