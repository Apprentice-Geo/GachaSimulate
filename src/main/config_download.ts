export const OFFICIAL_CONFIG_INDEX_URL =
  "https://raw.githubusercontent.com/Apprentice-Geo/GachaSimulate-Configs/main/dist/index.json";
export const CONFIG_INDEX_DOWNLOAD_LIMIT = 1024 * 1024;
export const CONFIG_ZIP_DOWNLOAD_LIMIT = 8 * 1024 * 1024;
export const CONFIG_DOWNLOAD_TIMEOUT_MS = 30_000;
export const CONFIG_REDIRECT_LIMIT = 5;

type ResponseLike = NodeJS.ReadableStream & {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  destroy(error?: Error): void;
};

type RequestLike = NodeJS.EventEmitter & {
  abort(): void;
  end(): void;
};

export type ConfigRequest = (options: {
  method: "GET";
  redirect: "manual";
  url: string;
}) => RequestLike;

function location_header(response: ResponseLike): string | undefined {
  const value = response.headers.location;
  return Array.isArray(value) ? value[0] : value;
}

export async function download_https(
  url: string,
  limit: number,
  request: ConfigRequest,
  timeout_ms = CONFIG_DOWNLOAD_TIMEOUT_MS,
  redirects = 0,
): Promise<Buffer> {
  if (new URL(url).protocol !== "https:")
    throw new Error("configuration downloads require HTTPS");

  return new Promise<Buffer>((resolve, reject) => {
    const client = request({ method: "GET", redirect: "manual", url });
    let settled = false;
    let ignore_client_errors = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };
    const reset_timeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        finish(new Error("configuration download timed out"));
        client.abort();
      }, timeout_ms);
    };

    reset_timeout();
    client.on("error", (error) => {
      if (!ignore_client_errors)
        finish(error instanceof Error ? error : new Error(String(error)));
    });
    client.on("response", (response: ResponseLike) => {
      const status = response.statusCode;
      if (status >= 300 && status < 400) {
        const location = location_header(response);
        ignore_client_errors = true;
        clearTimeout(timer);
        response.destroy();
        client.abort();
        if (!location) {
          finish(new Error("configuration redirect is missing Location"));
          return;
        }
        if (redirects >= CONFIG_REDIRECT_LIMIT) {
          finish(new Error("configuration download exceeded 5 redirects"));
          return;
        }
        const target = new URL(location, url);
        if (target.protocol !== "https:") {
          finish(new Error("configuration redirect must use HTTPS"));
          return;
        }
        void download_https(
          target.href,
          limit,
          request,
          timeout_ms,
          redirects + 1,
        ).then((value) => finish(undefined, value), finish);
        return;
      }
      if (status < 200 || status >= 300) {
        finish(new Error(`configuration download returned HTTP ${status}`));
        response.destroy();
        client.abort();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (raw: Buffer | Uint8Array | string) => {
        reset_timeout();
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        size += chunk.length;
        if (size > limit) {
          finish(new Error(`configuration download exceeds ${limit} bytes`));
          response.destroy();
          client.abort();
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", (error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );
      response.on("end", () => finish(undefined, Buffer.concat(chunks, size)));
    });
    client.end();
  });
}
