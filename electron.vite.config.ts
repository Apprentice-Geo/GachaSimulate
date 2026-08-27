import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@gachasimulate/config-compiler",
          "@gachasimulate/config-repository-contract",
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ["electron"],
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          export: resolve(__dirname, "src/preload/export.ts"),
        },
        output: {
          chunkFileNames: "chunks/[name]-[hash].js",
          entryFileNames: "[name].js",
          format: "cjs",
        },
      },
    },
  },
  renderer: {
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
  },
});
