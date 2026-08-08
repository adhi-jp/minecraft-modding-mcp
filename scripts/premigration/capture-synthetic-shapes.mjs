/**
 * Pre-migration baseline capture — supervisor synthetic-result shapes.
 *
 * Run with: node --import tsx scripts/premigration/capture-synthetic-shapes.mjs [--validate-only]
 *
 * Captures the client-visible replies for the seven synthetic terminal paths
 * against the untouched v1 build. Injection methods (all external — no src/
 * changes):
 *
 *  - restart x tools/call (structured, toggle on): legacy handshake; SIGSTOP
 *    the worker (pid from MCP_SUPERVISOR_CHILD_PID_FILE) to hold the pending
 *    request window open deterministically; send a tools/call; SIGKILL the
 *    worker -> supervisor synthesizes the structured restart CallToolResult.
 *  - restart x other (raw -32603): same, with resources/list in flight.
 *  - restart x toggle-off: restart x tools/call repeated under
 *    SUPERVISOR_STRUCTURED_RESTART_OFF=1 -> raw -32603 for tools/call too.
 *  - overflow x tools/call and overflow x other: SIGSTOP the worker; send one
 *    tools/call (becomes pending), then a validate-project (queued; arms the
 *    dispatch barrier), then one more tools/call (queued; queue is now at
 *    MAX_SUPERVISOR_QUEUE=2); the next tools/call gets the structured
 *    queue-limit reply and the next resources/list gets the raw -32000.
 *  - timeout x validate-project: MCP_VALIDATE_PROJECT_TIMEOUT_MS=10000 (the
 *    minimum); SIGSTOP the worker; send validate-project -> after 10 s the
 *    supervisor synthesizes the structured timeout reply (phase "running")
 *    and restarts the worker.
 *  - replay-failure/startup-failure terminalization: spawn the server with
 *    MCP_SUPERVISOR_CHILD_PID_FILE pointing into a nonexistent directory; the
 *    worker-mode process throws in writeFileSync BEFORE startServer, so every
 *    worker generation dies pre-READY (exit code 1). Queued requests are
 *    terminalized by failQueuedRequestsOnStartupFailure: tools/call ->
 *    structured restart-shape reply, other methods -> raw -32603, retained
 *    initialize -> raw -32603. (A genuine gen-2 initialize replay REJECTION is
 *    not externally injectable against the real worker — see the fixtures
 *    README limitation note; a pre-migration spike proved replay failure and startup failure
 *    terminalize through the same path.)
 *
 * Fixtures: tests/fixtures/premigration/synthetic-shapes/*.json (normalized
 * per lib.mjs rules N1-N5; exit signal/code and retryRecommendation values are
 * part of the pinned shape and depend on the injection — recorded per fixture).
 */

import { join } from "node:path";

import {
  ServerSession,
  normalizeCaptured,
  writeFixture,
  scratchPath,
  sleep,
  SCRATCH_ROOT
} from "./lib.mjs";

const validateOnly = process.argv.includes("--validate-only");
let failures = 0;

function check(label, condition, actual) {
  if (condition) {
    console.log(`[${label}] OK`);
    return true;
  }
  failures += 1;
  console.error(`[${label}] FAILED: ${JSON.stringify(actual).slice(0, 500)}`);
  return false;
}

function fixture(name, data) {
  if (validateOnly) return;
  writeFixture(`synthetic-shapes/${name}`, data);
  console.log(`fixture written: synthetic-shapes/${name}`);
}

// ---------------------------------------------------------------------------
// 1-3. restart x {tools/call, other, toggle-off}
// ---------------------------------------------------------------------------

async function captureRestart({ label, env, fileName, sendRequest, expect }) {
  const session = new ServerSession({
    label,
    env,
    pidFile: scratchPath("run", `${label}.pid`)
  }).start();
  try {
    await session.handshake();
    const workerPid = await session.waitForWorkerReady();
    process.kill(workerPid, "SIGSTOP"); // hold the in-flight window open
    await sleep(100);
    const { request, reply } = sendRequest(session);
    await sleep(300); // let the supervisor forward the request (pending set)
    process.kill(workerPid, "SIGKILL");
    const message = await reply;
    const ok = expect(message);
    check(label, ok, message);
    if (ok) {
      fixture(fileName, {
        description: `Pre-migration supervisor synthetic restart reply. Injection: legacy handshake, SIGSTOP worker, request in flight, SIGKILL worker (exit signal SIGKILL => retryRecommendation "clear-cache" on structured replies).`,
        harness: "scripts/premigration/capture-synthetic-shapes.mjs",
        env: session.recordedEnv(),
        injection: "SIGSTOP worker -> send request -> SIGKILL worker (pid from MCP_SUPERVISOR_CHILD_PID_FILE)",
        request: normalizeCaptured(request),
        reply: normalizeCaptured(message)
      });
    }
  } finally {
    await session.stop();
  }
}

await captureRestart({
  label: "restart-toolscall-structured",
  env: {},
  fileName: "restart-toolscall-structured.json",
  sendRequest: (session) =>
    session.request("tools/call", { name: "get-runtime-metrics", arguments: {} }, { timeoutMs: 30_000 }),
  expect: (message) =>
    message.result?.isError === true &&
    message.result?.structuredContent?.error?.code === "ERR_WORKER_RESTART"
});

await captureRestart({
  label: "restart-other-raw",
  env: {},
  fileName: "restart-other-raw.json",
  sendRequest: (session) => session.request("resources/list", {}, { timeoutMs: 30_000 }),
  expect: (message) => message.error?.code === -32603
});

await captureRestart({
  label: "restart-toolscall-toggle-off",
  env: { SUPERVISOR_STRUCTURED_RESTART_OFF: "1" },
  fileName: "restart-toolscall-toggle-off.json",
  sendRequest: (session) =>
    session.request("tools/call", { name: "get-runtime-metrics", arguments: {} }, { timeoutMs: 30_000 }),
  expect: (message) => message.error?.code === -32603
});

// ---------------------------------------------------------------------------
// 4-5. overflow x {tools/call, other}
// ---------------------------------------------------------------------------

{
  const session = new ServerSession({
    label: "overflow",
    env: {},
    pidFile: scratchPath("run", "overflow.pid")
  }).start();
  try {
    await session.handshake();
    const workerPid = await session.waitForWorkerReady();
    process.kill(workerPid, "SIGSTOP");
    await sleep(100);

    // R1 occupies the worker (pending); V arms the validate-project dispatch
    // barrier from the queue; N1 fills the queue to MAX_SUPERVISOR_QUEUE=2.
    const ignored = [];
    ignored.push(session.request("tools/call", { name: "get-runtime-metrics", arguments: {} }));
    ignored.push(
      session.request("tools/call", {
        name: "validate-project",
        arguments: { projectPath: "/workspace/example-mod" }
      })
    );
    ignored.push(session.request("tools/call", { name: "get-runtime-metrics", arguments: {} }));
    for (const entry of ignored) entry.reply.catch(() => {});
    await sleep(300);

    const overflowCall = session.request(
      "tools/call",
      { name: "get-runtime-metrics", arguments: {} },
      { timeoutMs: 15_000 }
    );
    const callMessage = await overflowCall.reply;
    const callOk =
      callMessage.result?.isError === true &&
      callMessage.result?.structuredContent?.error?.code === "ERR_LIMIT_EXCEEDED";
    check("overflow-toolscall", callOk, callMessage);
    if (callOk) {
      fixture("overflow-toolscall.json", {
        description:
          "Pre-migration supervisor queue-limit reply for tools/call: structured isError CallToolResult with ERR_LIMIT_EXCEEDED. Injection: worker SIGSTOPped, one pending tools/call, queued validate-project (dispatch barrier) + one more queued request fill MAX_SUPERVISOR_QUEUE=2, then this call overflows.",
        harness: "scripts/premigration/capture-synthetic-shapes.mjs",
        env: session.recordedEnv(),
        injection: "SIGSTOP worker; 1 pending tools/call + queued validate-project + 1 queued tools/call; overflow probe",
        request: normalizeCaptured(overflowCall.request),
        reply: normalizeCaptured(callMessage)
      });
    }

    const overflowOther = session.request("resources/list", {}, { timeoutMs: 15_000 });
    const otherMessage = await overflowOther.reply;
    const otherOk = otherMessage.error?.code === -32000;
    check("overflow-other", otherOk, otherMessage);
    if (otherOk) {
      fixture("overflow-other.json", {
        description:
          "Pre-migration supervisor queue-limit reply for a non-tools/call method: raw JSON-RPC -32000 error. Same injection/session as overflow-toolscall.json (queue still full).",
        harness: "scripts/premigration/capture-synthetic-shapes.mjs",
        env: session.recordedEnv(),
        injection: "same session as overflow-toolscall.json; queue still full; resources/list probe",
        request: normalizeCaptured(overflowOther.request),
        reply: normalizeCaptured(otherMessage)
      });
    }
  } finally {
    await session.stop();
  }
}

// ---------------------------------------------------------------------------
// 6. timeout x validate-project
// ---------------------------------------------------------------------------

{
  const session = new ServerSession({
    label: "timeout-validate-project",
    env: { MCP_VALIDATE_PROJECT_TIMEOUT_MS: "10000" },
    pidFile: scratchPath("run", "timeout-validate-project.pid")
  }).start();
  try {
    await session.handshake();
    const workerPid = await session.waitForWorkerReady();
    process.kill(workerPid, "SIGSTOP"); // validate-project can never finish
    await sleep(100);
    const { request, reply } = session.request(
      "tools/call",
      { name: "validate-project", arguments: { projectPath: "/workspace/example-mod" } },
      { timeoutMs: 25_000 }
    );
    const message = await reply;
    const ok =
      message.result?.isError === true &&
      message.result?.structuredContent?.error?.code === "ERR_TOOL_TIMEOUT" &&
      message.result?.structuredContent?.meta?.timeout?.phase === "running";
    check("timeout-validate-project", ok, message);
    if (ok) {
      fixture("timeout-validate-project.json", {
        description:
          'Pre-migration validate-project timeout synthesis: structured isError CallToolResult with ERR_TOOL_TIMEOUT, phase "running", workerRestartInitiated true. Injection: MCP_VALIDATE_PROJECT_TIMEOUT_MS=10000 (the minimum), worker SIGSTOPped so the call cannot finish.',
        harness: "scripts/premigration/capture-synthetic-shapes.mjs",
        env: session.recordedEnv(),
        injection: "MCP_VALIDATE_PROJECT_TIMEOUT_MS=10000; SIGSTOP worker; send validate-project; wait for deadline",
        request: normalizeCaptured(request),
        reply: normalizeCaptured(message)
      });
    }
  } finally {
    await session.stop();
  }
}

// ---------------------------------------------------------------------------
// 7. replay-failure/startup-failure terminalization
// ---------------------------------------------------------------------------

{
  // Do NOT create this directory: the worker-mode writeFileSync must throw.
  const badPidFile = join(SCRATCH_ROOT, "premigration-no-such-dir", "worker.pid");
  const session = new ServerSession({
    label: "startup-failure",
    env: { MCP_SUPERVISOR_CHILD_PID_FILE: badPidFile }
  }).start();
  try {
    // Pipelined before any worker can become ready: initialize is retained,
    // the two ordinary requests queue, and the first startup failure
    // terminalizes all of them.
    const init = session.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "premigration-harness", version: "0.0.0" }
    }, { timeoutMs: 60_000 });
    const call = session.request(
      "tools/call",
      { name: "get-runtime-metrics", arguments: {} },
      { timeoutMs: 60_000 }
    );
    const other = session.request("resources/list", {}, { timeoutMs: 60_000 });

    const [initMessage, callMessage, otherMessage] = await Promise.all([
      init.reply,
      call.reply,
      other.reply
    ]);
    const ok =
      initMessage.error?.code === -32603 &&
      callMessage.result?.isError === true &&
      callMessage.result?.structuredContent?.error?.code === "ERR_WORKER_RESTART" &&
      otherMessage.error?.code === -32603;
    check("startup-failure-terminalization", ok, { initMessage, callMessage, otherMessage });
    if (ok) {
      fixture("startup-failure-terminalization.json", {
        description:
          "Pre-migration startup-failure terminalization of queued work (replay failure = startup failure, same terminal path). Every worker generation dies pre-READY (exit code 1), so queued requests are failed, not hung: queued tools/call -> structured restart-shape reply (ERR_WORKER_RESTART), queued non-tools/call -> raw -32603, retained initialize -> raw -32603.",
        harness: "scripts/premigration/capture-synthetic-shapes.mjs",
        env: session.recordedEnv(),
        injection:
          "MCP_SUPERVISOR_CHILD_PID_FILE points into a nonexistent directory; the worker-mode process throws in writeFileSync before startServer and exits 1 on every generation; initialize + tools/call + resources/list are pipelined before readiness",
        requests: {
          initialize: normalizeCaptured(init.request),
          toolsCall: normalizeCaptured(call.request),
          other: normalizeCaptured(other.request)
        },
        replies: {
          initialize: normalizeCaptured(initMessage),
          toolsCall: normalizeCaptured(callMessage),
          other: normalizeCaptured(otherMessage)
        }
      });
    }
  } finally {
    await session.stop();
  }
}

if (failures > 0) {
  console.error(`FAILED: ${failures} synthetic-shape scenario(s) did not match`);
  process.exit(1);
}
console.log("synthetic-shapes capture: OK");
