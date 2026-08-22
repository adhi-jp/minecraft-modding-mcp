import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

/**
 * Framing-violation behavior over the REAL wire (production supervisor +
 * production SDK worker), spawned exactly as a launcher would.
 *
 * The invariant under test: after ANY framing violation the reader either
 * provably resynchronizes — resuming at an offset the peer itself delimited —
 * or the session is terminated with a diagnostic. It must never silently
 * consume subsequent valid frames.
 *
 * The regression this pins: a 26-byte `Content-Length: 999999999\r\n\r\n` with
 * NO body used to arm a discard countdown with the attacker-declared length.
 * The reader then refused to reclassify any input until 999999999 bytes had
 * been consumed, so every later frame — including perfectly valid ones — was
 * swallowed for the process lifetime while the process stayed up, answering
 * nothing. A single unanswerable header was a permanent denial of service.
 */

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const MODERN_META = { [PROTOCOL_VERSION_KEY]: "2026-07-28", [CLIENT_CAPABILITIES_KEY]: {} };

type Frame = Record<string, unknown> & { id?: unknown };

type Session = {
  child: ChildProcessWithoutNullStreams;
  frames: Frame[];
  stderr: () => string;
  workerReady: () => boolean;
  exit: () => { code: number | null; signal: NodeJS.Signals | null } | undefined;
  writeRaw: (payload: string) => void;
  send: (message: object) => void;
};

function startSupervisor(root: string): Session {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MCP_SUPERVISOR_DEBUG: "1",
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

  let stderrBuffer = "";
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });

  // stdin may be torn down under us by a framing-fatal teardown; a write to
  // the closed pipe must not crash the test process.
  child.stdin.on("error", () => {});

  return {
    child,
    frames,
    stderr: () => stderrBuffer,
    workerReady: () => stderrBuffer.includes("supervisor.debug.worker_ready"),
    exit: () => exit,
    writeRaw: (payload) => child.stdin.write(payload),
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

function discover(id: number): object {
  return { jsonrpc: "2.0", id, method: "server/discover", params: { _meta: MODERN_META } };
}

test("wire: a Content-Length header whose declared body never arrives terminates the session instead of wedging the reader", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "framing-fatal-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // 26 bytes, no body. Nothing here is expensive for the attacker and the
  // declared length can never be delivered.
  session.writeRaw("Content-Length: 999999999\r\n\r\n");
  session.send(discover(9));

  await waitFor(() => session.exit() !== undefined, 60_000, "the framing-fatal session teardown");

  const exit = session.exit();
  assert.equal(exit?.code, 1, "a client framing violation exits non-zero, distinguishable from the code 0 of an ordinary stdin close");
  assert.match(
    session.stderr(),
    /"event":"supervisor\.client_framing_fatal"/,
    "the teardown must name itself on stderr"
  );
  assert.match(
    session.stderr(),
    /Content-Length 999999999 exceeds the configured frame limit/,
    "the diagnostic names the observed size and the configured limit"
  );
  assert.match(
    session.stderr(),
    // The byte count depends on how the two writes coalesce into stdin chunks
    // (the discover's own bytes land inside the phantom body when they do);
    // what must always hold is that far fewer than the declared bytes arrived,
    // which is exactly why waiting for the rest can never be safe.
    /Only \d+ of the declared 999999999 body bytes have arrived/,
    "the diagnostic names WHY resynchronization is impossible"
  );
  assert.equal(
    session.frames.some((frame) => frame.id === 9),
    false,
    "a frame sent after the violation is not answered — the session is over, not silently deaf"
  );
});

test("wire: a Content-Length header carrying no usable length is recoverable and the next valid frame is still answered", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "native-stdio-pipes")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "framing-recover-wire-"));
  const session = startSupervisor(root);
  t.after(async () => {
    session.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(session.workerReady, 60_000, "supervisor worker_ready adoption");

  // Control for the test above: termination is reserved for violations the
  // reader cannot resynchronize from. Here the header block is fully
  // delimited and declares NO body length at all, so consuming the header
  // alone is a bounded, provable recovery — and the session must survive it.
  session.writeRaw("Content-Length: nope\r\n\r\n");
  session.send(discover(11));

  await waitFor(() => session.frames.some((frame) => frame.id === 11), 30_000, "server/discover reply after a recoverable framing error");

  const reply = session.frames.find((frame) => frame.id === 11) as { result?: unknown; error?: unknown };
  assert.equal(reply.error, undefined, "the discover after a recoverable framing error must be served normally");
  assert.ok(reply.result, "the reply carries a DiscoverResult");
  assert.equal(session.exit(), undefined, "a recoverable framing error must NOT end the session");
  assert.match(
    session.stderr(),
    /"event":"supervisor\.client_parse_error"/,
    "the recoverable violation is still reported, at warn level"
  );
  assert.doesNotMatch(
    session.stderr(),
    /"event":"supervisor\.client_framing_fatal"/,
    "no fatal teardown may be reported for a recoverable violation"
  );
});
