import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { download_https, type ConfigRequest } from "./config_download";

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  error?: Error;
  hang?: boolean;
};

function fake_request(
  replies: Reply[],
  requested: string[] = [],
): ConfigRequest {
  return (options) => {
    const client = new EventEmitter() as EventEmitter & {
      abort(): void;
      end(): void;
    };
    client.abort = () => {};
    client.end = () => {
      requested.push(options.url);
      const reply = replies.shift();
      if (!reply || reply.hang) return;
      queueMicrotask(() => {
        const response = new PassThrough() as PassThrough & {
          statusCode: number;
          headers: Record<string, string>;
        };
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        client.emit("response", response);
        for (const chunk of reply.chunks ?? []) response.write(chunk);
        if (reply.error) response.destroy(reply.error);
        else response.end();
      });
    };
    return client;
  };
}

test("limits actual response bytes regardless of Content-Length", async () => {
  for (const headers of [
    {},
    { "content-length": "1" },
    { "content-length": "999" },
  ] as Array<Record<string, string>>) {
    const body = await download_https(
      "https://example.test/index.json",
      4,
      fake_request([{ headers, chunks: [Buffer.from("1234")] }]),
    );
    assert.equal(body.toString(), "1234");
  }
  await assert.rejects(() =>
    download_https(
      "https://example.test/index.json",
      4,
      fake_request([{ chunks: [Buffer.from("12"), Buffer.from("345")] }]),
    ),
  );
});

test("follows five HTTPS redirects and rejects the sixth or a downgrade", async () => {
  const requested: string[] = [];
  const redirects = Array.from({ length: 5 }, (_, index) => ({
    status: 302,
    headers: { location: `https://example.test/${index + 1}` },
  }));
  const result = await download_https(
    "https://example.test/0",
    10,
    fake_request([...redirects, { chunks: [Buffer.from("done")] }], requested),
  );
  assert.equal(result.toString(), "done");
  assert.equal(requested.length, 6);

  await assert.rejects(() =>
    download_https(
      "https://example.test/0",
      10,
      fake_request([...redirects, redirects[0]]),
    ),
  );
  await assert.rejects(() =>
    download_https(
      "https://example.test/0",
      10,
      fake_request([{ status: 302, headers: { location: "http://bad.test" } }]),
    ),
  );
});

test("rejects non-2xx, inactivity, request failure, and interrupted bodies", async () => {
  await assert.rejects(() =>
    download_https(
      "https://example.test/index.json",
      10,
      fake_request([{ status: 500 }]),
    ),
  );
  await assert.rejects(
    () =>
      download_https(
        "https://example.test/index.json",
        10,
        fake_request([{ hang: true }]),
        5,
      ),
    /timed out/,
  );
  await assert.rejects(
    () =>
      download_https(
        "https://example.test/index.json",
        10,
        fake_request([
          { chunks: [Buffer.from("part")], error: new Error("cut") },
        ]),
      ),
    /cut/,
  );

  const request_error: ConfigRequest = () => {
    const client = new EventEmitter() as EventEmitter & {
      abort(): void;
      end(): void;
    };
    client.abort = () => {};
    client.end = () =>
      queueMicrotask(() => client.emit("error", new Error("network")));
    return client;
  };
  await assert.rejects(
    () => download_https("https://example.test/index.json", 10, request_error),
    /network/,
  );
});

test("rejects a non-HTTPS initial URL", async () => {
  await assert.rejects(() =>
    download_https("http://example.test/index.json", 10, fake_request([])),
  );
});
