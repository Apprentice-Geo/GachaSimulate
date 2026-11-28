import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/foundation.css";
import "./tokens.css";
import "./styles.css";
import { restore_theme } from "./theme";
import { createTauriDesktopClient } from "./desktop_client";
import { TauriWorkbenchApp } from "./TauriWorkbenchApp";

const initial_theme = restore_theme();
const client = createTauriDesktopClient({
  invoke: (command, args) => invoke(command, args),
  listen: (event, handler) =>
    listen(event, (envelope) => handler(envelope.payload as never)),
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <TauriWorkbenchApp client={client} initial_theme={initial_theme} />
  </StrictMode>,
);
