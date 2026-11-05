import type { DesktopIpc } from "./desktop_ipc";
import { invoke_desktop, subscribe_desktop } from "../preload/desktop_ipc";

/** Compiled by the normal typecheck; never invokes Electron at runtime. */
export function desktop_contract_type_checks(bridge: DesktopIpc): void {
  const cpu: Promise<number> = invoke_desktop("get-logical-cpu-count");
  void cpu;
  // @ts-expect-error unknown wire channel
  void invoke_desktop("unknown-desktop-channel");
  // @ts-expect-error CPU query has no request payload
  void invoke_desktop("get-logical-cpu-count", "unexpected");
  // @ts-expect-error simulation expects a validated request shape
  void invoke_desktop("start-simulation", { threads: "many" });
  // @ts-expect-error a list response is not a number response
  const wrong_response: Promise<number> = invoke_desktop("list-configs");
  void wrong_response;
  // @ts-expect-error main registration uses the same wire channel map
  bridge.handle("unknown-desktop-channel", () => undefined);
  // @ts-expect-error handler parameter must match the channel request
  bridge.handle("install-config", (id: number) => {
    throw new Error(String(id));
  });
  // @ts-expect-error handler result must match the channel response
  bridge.handle("get-logical-cpu-count", () => "four");
  // @ts-expect-error compact save response must contain a DisplayConfig
  bridge.handle("save-result-fields", () => ({
    session_id: "a",
    analysis: {},
  }));
  // @ts-expect-error event payload follows the event channel map
  bridge.send("simulation-event", { status: "unknown-status" });
  // @ts-expect-error subscription payload follows the event channel map
  subscribe_desktop("export-event", (event: number) => void event);
}
