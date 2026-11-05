import { parentPort } from "node:worker_threads";
import { ConfigSnapshotEngine } from "./config_snapshot";
import type {
  ConfigWorkerRequest,
  ConfigWorkerResponse,
} from "./config_worker_protocol";

if (!parentPort) throw new Error("configuration worker requires a parent port");
const port = parentPort;
const engine = new ConfigSnapshotEngine();

port.on("message", (request: ConfigWorkerRequest) => {
  let response: ConfigWorkerResponse;
  try {
    let value: unknown;
    switch (request.operation) {
      case "scan":
        value = engine.scan(
          request.value.installed_dir,
          request.value.local_dir,
        );
        break;
      case "validate":
        value = engine.validate_directory(
          request.value.directory,
          request.value.id,
          request.value.source,
        );
        break;
      case "verify_install":
        value = engine.verify_install(
          request.value.directory,
          request.value.id,
          request.value.receipt,
          request.value.sha256,
        );
        break;
      case "compile":
        value = engine.compile(
          request.value.directory,
          request.value.id,
          request.value.source,
          request.value.termination,
          request.value.result_item,
        );
        break;
      case "invalidate":
        value = engine.invalidate();
        break;
      default:
        throw new Error("unknown configuration worker operation");
    }
    response = { id: request.id, ok: true, value };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
});
