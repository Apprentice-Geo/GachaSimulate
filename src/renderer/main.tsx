import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../visualize/styles/tokens.css";
import "../visualize/styles/preview.css";
import "../visualize/styles/scene.css";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
