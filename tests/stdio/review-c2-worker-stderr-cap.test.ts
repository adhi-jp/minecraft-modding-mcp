import assert from "node:assert/strict";
import test from "node:test";

import { StdioSupervisor } from "../../src/stdio-supervisor.ts";

/**
 * The worker's stderr line assembler must stay bounded.
 *
 * `handleWorkerStderr` accumulates chunks until it sees a newline so a
 * `__MCP_STDIO_WORKER_READY__` marker split across reads is still recognized.
 * A worker (or the JVM it drives) that emits one very long newline-less line
 * therefore grew supervisor memory with no ceiling until the next spawn.
 */

/** Must match MAX_WORKER_STDERR_LINE_BYTES in src/stdio-supervisor.ts. */
const CAP_BYTES = 64 * 1024;
const CHUNK_BYTES = 200 * 1024;

type FakeChild = {
  pid: number;
  stdin: { destroyed: boolean; write(payload: string): boolean; removeAllListeners(): void };
  stdout: { removeAllListeners(): void };
  stderr: { removeAllListeners(): void };
  kill(): boolean;
};

type Harness = {
  child?: FakeChild;
  childReady: boolean;
  liveChildren: Set<FakeChild>;
  workerStderrBuffer: string;
  handleWorkerStderr(child: FakeChild, chunk: Buffer | string): void;
  handleWorkerReady(child: FakeChild): void;
  shutdown(): Promise<void>;
};

function createHarness(events: Array<{ level: string; event: string }>): {
  supervisor: Harness;
  child: FakeChild;
} {
  const supervisor = new StdioSupervisor({
    entryFile: "fixture.ts",
    clientWriter: () => {},
    eventWriter: (level, event) => events.push({ level, event })
  } as never) as unknown as Harness;
  const child: FakeChild = {
    pid: 606,
    stdin: {
      destroyed: false,
      write() { return true; },
      removeAllListeners() {}
    },
    stdout: { removeAllListeners() {} },
    stderr: { removeAllListeners() {} },
    kill: () => true
  };
  supervisor.child = child;
  supervisor.childReady = true;
  supervisor.liveChildren.add(child);
  return { supervisor, child };
}

test("a newline-less stderr flood never grows the pending-line buffer past the cap", async (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const events: Array<{ level: string; event: string }> = [];
  const { supervisor, child } = createHarness(events);

  for (let i = 0; i < 5; i += 1) {
    supervisor.handleWorkerStderr(child, "x".repeat(CHUNK_BYTES));
    assert.ok(
      Buffer.byteLength(supervisor.workerStderrBuffer, "utf8") <= CAP_BYTES,
      `pending stderr buffer must stay within ${CAP_BYTES} bytes (saw ${Buffer.byteLength(supervisor.workerStderrBuffer, "utf8")})`
    );
  }

  assert.equal(
    events.some((entry) => entry.event === "supervisor.worker_stderr_line_truncated"),
    true,
    "the truncation must be observable in the event stream"
  );
  assert.ok(written.length > 0, "the held prefix must still be flushed to stderr");

  await supervisor.shutdown();
});

test("the oversized line's remainder is dropped and normal lines resume after the next newline", async (t) => {
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  const events: Array<{ level: string; event: string }> = [];
  const { supervisor, child } = createHarness(events);

  supervisor.handleWorkerStderr(child, "x".repeat(CHUNK_BYTES));
  written.length = 0;
  // Still inside the oversized line: this tail must be discarded, not printed.
  supervisor.handleWorkerStderr(child, "y".repeat(1_000));
  assert.equal(written.length, 0, "the dropped remainder must not reach stderr");
  assert.equal(
    supervisor.workerStderrBuffer.length,
    0,
    "the dropped remainder must not be retained"
  );

  // The newline ends the oversized line; the next line is normal again.
  supervisor.handleWorkerStderr(child, "tail-of-dropped-line\nrecovered-line\n");
  assert.deepEqual(written, ["recovered-line\n"], "only the line after the newline is printed");

  await supervisor.shutdown();
});

test("a ready marker split across chunks is still recognized after a truncated line", async (t) => {
  t.mock.method(process.stderr, "write", () => true);
  const events: Array<{ level: string; event: string }> = [];
  const { supervisor, child } = createHarness(events);
  let ready = 0;
  (supervisor as unknown as { handleWorkerReady(child: FakeChild): void }).handleWorkerReady = () => {
    ready += 1;
  };

  supervisor.handleWorkerStderr(child, "x".repeat(CHUNK_BYTES));
  supervisor.handleWorkerStderr(child, "end-of-flood\n__MCP_STDIO_WORKER");
  assert.equal(ready, 0, "a partial marker must not fire readiness");
  supervisor.handleWorkerStderr(child, "_READY__\n");
  assert.equal(ready, 1, "the reassembled marker must fire readiness exactly once");

  await supervisor.shutdown();
});
