import assert from "node:assert/strict";
import test from "node:test";
import type { IpcMainInvokeEvent, WebFrameMain } from "electron";
import { DesktopIpc, is_desktop_url } from "./desktop_ipc";

function fixture() {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  >();
  let destroyed = false;
  const frame = { url: "file:///D:/app/index.html" };
  const messages: unknown[] = [];
  const contents = {
    mainFrame: frame as WebFrameMain,
    isDestroyed: () => destroyed,
    send: (channel: string, value: unknown) =>
      messages.push({ channel, value }),
  };
  const window = { isDestroyed: () => destroyed, webContents: contents };
  const bridge = new DesktopIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
    () => window,
    frame.url,
  );
  const event = {
    sender: contents,
    senderFrame: frame,
  } as unknown as IpcMainInvokeEvent;
  return {
    bridge,
    handlers,
    event,
    frame,
    messages,
    destroy: () => {
      destroyed = true;
    },
  };
}

test("desktop handlers check window, main frame and URL before validation or side effects", () => {
  const w = fixture();
  let calls = 0;
  w.bridge.handle("get-logical-cpu-count", () => {
    calls += 1;
    return 4;
  });
  const handler = w.handlers.get("get-logical-cpu-count")!;
  assert.equal(handler(w.event), 4);
  for (const event of [
    { ...w.event, sender: {} },
    { ...w.event, senderFrame: { url: w.frame.url } },
    { ...w.event, senderFrame: null },
  ])
    assert.throws(
      () => handler(event as IpcMainInvokeEvent, "invalid"),
      /untrusted renderer/,
    );
  w.frame.url = "file:///D:/other/index.html";
  assert.throws(() => handler(w.event), /untrusted renderer/);
  w.frame.url = "file:///D:/app/index.html";
  w.destroy();
  assert.throws(() => handler(w.event), /untrusted renderer/);
  assert.equal(calls, 1);
});

test("runtime request validation rejects malformed arguments before business code", () => {
  const w = fixture();
  let calls = 0;
  w.bridge.handle("install-config", () => {
    calls += 1;
    throw new Error("business called");
  });
  const install = w.handlers.get("install-config")!;
  for (const args of [[], [null], [{}], ["a", "extra"]])
    assert.throws(() => install(w.event, ...args), /argument|configuration id/);
  w.bridge.handle("save-result-fields", () => {
    calls += 1;
    throw new Error("business called");
  });
  assert.throws(
    () =>
      w.handlers.get("save-result-fields")!(w.event, {
        session_id: "x",
        fields: {},
      }),
    /display fields/,
  );
  w.bridge.handle("refresh-config-repository", (force = false) => {
    calls += 1;
    throw new Error(String(force));
  });
  const refresh = w.handlers.get("refresh-config-repository")!;
  assert.throws(() => refresh(w.event, "true"), /refresh flag/);
  assert.throws(() => refresh(w.event, undefined), /false/);
  assert.equal(calls, 1);
});

test("events are delivered only to the valid application window and stop after destruction", () => {
  const w = fixture();
  w.bridge.send("simulation-event", { status: "idle" });
  assert.deepEqual(w.messages, [
    { channel: "simulation-event", value: { status: "idle" } },
  ]);
  w.frame.url = "https://example.invalid/";
  w.bridge.send("simulation-event", { status: "running" });
  w.frame.url = "file:///D:/app/index.html";
  w.destroy();
  assert.doesNotThrow(() =>
    w.bridge.send("simulation-event", { status: "completed" }),
  );
  assert.equal(w.messages.length, 1);
});

test("application URLs allow fragments but retain the configured page, query and origin", () => {
  for (const expected of [
    "file:///D:/app/index.html",
    "http://localhost:5173/",
  ]) {
    assert.equal(is_desktop_url(`${expected}#view`, expected), true);
    assert.equal(is_desktop_url(`${expected}?unexpected=1`, expected), false);
    assert.equal(is_desktop_url(`${expected}/other`, expected), false);
    assert.equal(is_desktop_url("about:blank", expected), false);
  }
  assert.equal(
    is_desktop_url("http://localhost:5174/", "http://localhost:5173/"),
    false,
  );
});
