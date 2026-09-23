import { rename, writeFile } from "node:fs/promises";

import { createDirectWorkerBridgeTransport } from "./manual-stdio-bridge.ts";

const resultPath = process.env.MANUAL_STDIO_BRIDGE_RESULT_PATH;

if (!resultPath) {
  throw new Error("MANUAL_STDIO_BRIDGE_RESULT_PATH is required.");
}

// Write to a sibling temp file and rename into place. A plain writeFile lets a
// concurrent reader (waitForFileText in the test) observe a partially written
// file; rename on the same filesystem is atomic, so the reader only ever sees
// the file absent or complete.
async function writeResultAtomic(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, path);
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
  await writeResultAtomic(
    resultPath,
    JSON.stringify({
      status: "started"
    })
  );
  exitCode = 1;
} catch (error) {
  await writeResultAtomic(
    resultPath,
    JSON.stringify({
      status: "rejected",
      message: error instanceof Error ? error.message : String(error)
    })
  );
}

process.exit(exitCode);
