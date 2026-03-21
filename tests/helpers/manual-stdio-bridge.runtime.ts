import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { createDirectWorkerBridgeTransport } from "./manual-stdio-bridge.ts";

const root = await mkdtemp(join(tmpdir(), "manual-stdio-bridge-runtime-"));
await mkdir(join(root, "cache"), { recursive: true });

const transport = createDirectWorkerBridgeTransport({
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    MCP_CACHE_DIR: join(root, "cache"),
    MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
  }
});
const client = new Client({ name: "manual-stdio-bridge-runtime", version: "1.0.0" });
let exitCode = 0;

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const payload = JSON.stringify({
    toolNames: tools.map((tool) => tool.name)
  });
  const resultPath = process.env.MANUAL_STDIO_BRIDGE_RESULT_PATH;
  if (resultPath) {
    await writeFile(resultPath, `${payload}\n`, "utf8");
  } else {
    await new Promise<void>((resolve) => {
      if (process.stdout.write(`${payload}\n`)) {
        resolve();
        return;
      }
      process.stdout.once("drain", () => resolve());
    });
  }
} catch (error) {
  exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await transport.close();
  await rm(root, { recursive: true, force: true });
}

process.exit(exitCode);
