import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

/**
 * Five-version legacy negotiation matrix, driven over the REAL wire
 * (production supervisor + production SDK worker): every approved legacy
 * protocol version is echoed VERBATIM by initialize negotiation, and a bogus
 * legacy-shaped version negotiates DOWN to 2025-11-25 (the SDK's latest
 * legacy revision). The committed era-wire suite already covers the
 * discover-then-initialize legacy-shaped "2026-07-28" negotiate-down case
 * (tests/stdio/stdio-worker-protocol.test.ts fresh-factory negotiate-down);
 * this matrix adds the per-version echoes and the bogus-version case.
 */

const APPROVED_LEGACY_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07"
] as const;

const NEGOTIATE_DOWN_TARGET = "2025-11-25";

type Frame = Record<string, unknown> & { id?: unknown };

function startSupervisor(root: string): {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  send: (message: object) => void;
} {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_CACHE_DIR: join(root, "cache"),
      MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let buffer = "";
  const frames: Frame[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        frames.push(JSON.parse(line) as Frame);
      } catch {
        // Ignore non-JSON stdout noise.
      }
    }
  });

  return {
    child,
    frames,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function negotiate(
  t: Parameters<NonNullable<Parameters<typeof test>[2]>>[0],
  requestedVersion: string
): Promise<{ protocolVersion?: unknown; serverInfo?: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "negotiation-matrix-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });

  session.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: requestedVersion,
      capabilities: {},
      clientInfo: { name: "negotiation-matrix-test", version: "1.0.0" }
    }
  });
  await waitFor(() => session.frames.some((frame) => frame.id === 1), 90_000, `initialize reply for ${requestedVersion}`);
  const reply = session.frames.find((frame) => frame.id === 1) as {
    result?: { protocolVersion?: unknown; serverInfo?: unknown };
    error?: unknown;
  };
  assert.equal(reply.error, undefined, `initialize(${requestedVersion}) must negotiate, not error`);
  assert.ok(reply.result, `initialize(${requestedVersion}) must carry a result`);
  return reply.result;
}

for (const version of APPROVED_LEGACY_VERSIONS) {
  test(`wire negotiation matrix: initialize ${version} is echoed verbatim`, { timeout: 120_000 }, async (t) => {
    if (await skipWithoutCapability(t, "native-stdio-pipes")) {
      return;
    }
    const result = await negotiate(t, version);
    assert.equal(result.protocolVersion, version, `the negotiated protocolVersion must echo ${version} VERBATIM`);
  });
}

test(`wire negotiation matrix: a bogus legacy-shaped version negotiates down to ${NEGOTIATE_DOWN_TARGET}`, { timeout: 120_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const result = await negotiate(t, "1999-01-01");
  assert.equal(
    result.protocolVersion,
    NEGOTIATE_DOWN_TARGET,
    "an unsupported legacy version must be countered with the latest legacy revision"
  );
});
