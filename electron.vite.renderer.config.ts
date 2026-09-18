import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export function create_renderer_config() {
  return {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    define: {
      __GACHASIMULATE_EXPORT_FRAME_PROBE__: JSON.stringify(
        process.env.GACHASIMULATE_EXPORT_FRAME_PROBE === "1",
      ),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          export: resolve(__dirname, "src/renderer/export.html"),
        },
      },
    },
  };
}
