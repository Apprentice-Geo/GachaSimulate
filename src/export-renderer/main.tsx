import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExportRendererApp from "./ExportRendererApp";
import "../styles/foundation.css";
import "../visualize/styles/index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Export renderer root is missing");

createRoot(root).render(
  <StrictMode>
    <ExportRendererApp />
  </StrictMode>,
);
