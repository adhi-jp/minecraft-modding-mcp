import { writeFile } from "node:fs/promises";

import { createDirectWorkerBridgeTransport } from "./manual-stdio-bridge.ts";

const resultPath = process.env.MANUAL_STDIO_BRIDGE_RESULT_PATH;

if (!resultPath) {
  throw new Error("MANUAL_STDIO_BRIDGE_RESULT_PATH is required.");
}

const transport = createDirectWorkerBridgeTransport({
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: ""
  }
});

let exitCode = 0;

try {
  await transport.start();
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "started"
    }),
    "utf8"
  );
  exitCode = 1;
} catch (error) {
  await writeFile(
    resultPath,
    JSON.stringify({
      status: "rejected",
      message: error instanceof Error ? error.message : String(error)
    }),
    "utf8"
  );
}

process.exit(exitCode);
