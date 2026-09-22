import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "../styles/foundation.css";
import "../visualize/styles/index.css";
import "../visualize/styles/preview.css";
import "./tokens.css";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
