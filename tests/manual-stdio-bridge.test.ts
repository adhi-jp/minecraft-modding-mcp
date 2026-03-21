import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { selectManualStdioMode } from "./helpers/manual-stdio-bridge.ts";

const execFileAsync = promisify(execFile);

async function waitForFileText(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Timed out waiting for ${path}`);
}

test("selectManualStdioMode falls back to the bash bridge when native spawn pipes are unavailable", () => {
  assert.deepEqual(selectManualStdioMode(true), {
    kind: "native",
    supportsWorkerRestartValidation: true
  });

  assert.deepEqual(selectManualStdioMode(false), {
    kind: "bash-bridge",
    supportsWorkerRestartValidation: false,
    detail: "Node child-process stdio pipes close stdin immediately in this runtime."
  });
});

test("createDirectWorkerBridgeTransport connects to the CLI worker over bash-managed stdio", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash FIFO bridge is only exercised on POSIX runtimes.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "manual-stdio-bridge-test-"));
  const resultPath = join(root, "result.json");

  try {
    await execFileAsync(
      "node",
      ["--import", "tsx", "tests/helpers/manual-stdio-bridge.runtime.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MANUAL_STDIO_BRIDGE_RESULT_PATH: resultPath
        },
        timeout: 15_000
      }
    );

    const payload = JSON.parse(await readFile(resultPath, "utf8")) as {
      toolNames: string[];
    };

    assert.ok(payload.toolNames.includes("list-versions"));
    assert.ok(payload.toolNames.includes("inspect-minecraft"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createDirectWorkerBridgeTransport rejects startup promptly when the bridge process exits before FIFO open", async (t) => {
  if (process.platform === "win32") {
    t.skip("bash FIFO bridge is only exercised on POSIX runtimes.");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "manual-stdio-bridge-failure-test-"));
  const resultPath = join(root, "result.json");

  try {
    const child = spawn(
      "node",
      ["--import", "tsx", "tests/helpers/manual-stdio-bridge-start-failure.runtime.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MANUAL_STDIO_BRIDGE_RESULT_PATH: resultPath
        },
        stdio: ["ignore", "ignore", "ignore"]
      }
    );

    try {
      const payload = JSON.parse(await waitForFileText(resultPath, 4_000)) as {
        status: string;
        message?: string;
      };

      assert.equal(payload.status, "rejected");
      assert.match(payload.message ?? "", /manual stdio bridge failed to start:/);
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
