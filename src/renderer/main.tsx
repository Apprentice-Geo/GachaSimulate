import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ExportSpikeApp from "./ExportSpikeApp";
import "../visualize/styles/tokens.css";
import "../visualize/styles/preview.css";
import "../visualize/styles/scene.css";
import "./styles.css";

const is_export_spike = new URLSearchParams(location.search).has(
  "electron-export-spike",
);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>{is_export_spike ? <ExportSpikeApp /> : <App />}</StrictMode>,
);
