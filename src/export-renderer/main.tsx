import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExportRendererApp from "./ExportRendererApp";
import "../visualize/styles/tokens.css";
import "../visualize/styles/scene.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Export renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <ExportRendererApp />
  </StrictMode>,
);
