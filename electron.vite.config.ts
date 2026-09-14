import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { resolve } from "node:path";
import { create_renderer_config } from "./electron.vite.renderer.config";

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
  renderer: create_renderer_config(),
});
