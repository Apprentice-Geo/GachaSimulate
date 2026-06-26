import { useLayoutEffect } from "react";

const CANVAS_WIDTH = 3840;
const CANVAS_HEIGHT = 2160;

function update_scale() {
  const scale = Math.min(
    window.innerWidth / CANVAS_WIDTH,
    window.innerHeight / CANVAS_HEIGHT,
    1.0,
  );
  document.documentElement.style.setProperty(
    "--page-scale",
    String(Math.max(0.1, scale)),
  );
}

export function use_page_scale() {
  useLayoutEffect(() => {
    update_scale();
    // No resize listener — browser zoom should work natively.
    // Scale is calculated once on mount; a page refresh is needed
    // to re-fit after a window resize.
  }, []);
}
