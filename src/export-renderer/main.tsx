import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExportRendererApp from "./ExportRendererApp";
import { CANVAS_STYLE } from "../visualize/view/scene_layout";
import "../styles/foundation.css";
import "../visualize/styles/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Export renderer root is missing");

for (const [name, value] of Object.entries(CANVAS_STYLE)) {
  document.documentElement.style.setProperty(name, value);
}

createRoot(root).render(
  <StrictMode>
    <ExportRendererApp />
  </StrictMode>,
);
