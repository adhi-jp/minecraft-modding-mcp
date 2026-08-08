/**
 * Pre-migration baseline capture — observed wire error-code inventory.
 *
 * Run with: node --import tsx scripts/premigration/build-error-code-inventory.mjs [--validate-only]
 *
 * An observed-wire enumeration: two live probes (unmatched resources/read URI;
 * disabled-tool tools/call under BATCH_TOOLS_OFF=1) plus the codes extracted
 * from the already-captured fixtures (problemdetails/* and
 * synthetic-shapes/* must exist — run those harnesses first).
 *
 * Every entry records: path (error path name), method, wire code (JSON-RPC
 * error.code, or null for successful isError tool results), the ProblemDetails
 * `code` when the reply is an isError tool result, and the classification
 * "raw-jsonrpc-error" vs "isError-tool-result".
 *
 * Output: tests/fixtures/premigration/error-code-inventory.json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  ServerSession,
  writeFixture,
  scratchPath,
  FIXTURES_DIR,
  normalizeCaptured
} from "./lib.mjs";

const validateOnly = process.argv.includes("--validate-only");
let failures = 0;
const entries = [];

function classify(reply) {
  if (reply.error) {
    return {
      wireCode: reply.error.code,
      problemCode: null,
      classification: "raw-jsonrpc-error",
      errorMessage: reply.error.message
    };
  }
  if (reply.result?.isError === true) {
    return {
      wireCode: null,
      problemCode: reply.result.structuredContent?.error?.code ?? null,
      classification: "isError-tool-result",
      embeddedText: reply.result.content?.[0]?.text?.slice(0, 200)
    };
  }
  return { wireCode: null, problemCode: null, classification: "success" };
}

// ---------------------------------------------------------------------------
// Live probe 1: unmatched resource URI (default flag config)
// ---------------------------------------------------------------------------

{
  const session = new ServerSession({
    label: "error-inventory-default",
    env: {},
    pidFile: scratchPath("run", "error-inventory-default.pid")
  }).start();
  try {
    await session.handshake();
    const probe = session.request(
      "resources/read",
      { uri: "mc://premigration/no-such-resource" },
      { timeoutMs: 30_000 }
    );
    const reply = await probe.reply;
    const observed = classify(reply);
    const ok = observed.classification === "raw-jsonrpc-error" && observed.wireCode === -32602;
    if (!ok) {
      failures += 1;
      console.error(`[unmatched-resource] expected raw -32602, got ${JSON.stringify(reply).slice(0, 300)}`);
    } else {
      console.log(`[unmatched-resource] raw -32602 observed`);
    }
    entries.push({
      path: "unmatched-resource-uri",
      method: "resources/read",
      source: "live probe (this harness): resources/read mc://premigration/no-such-resource",
      ...observed,
      reply: normalizeCaptured(reply)
    });
  } finally {
    await session.stop();
  }
}

// ---------------------------------------------------------------------------
// Live probe 2: disabled tool (BATCH_TOOLS_OFF=1 disables batch-class-source)
// ---------------------------------------------------------------------------

{
  const session = new ServerSession({
    label: "error-inventory-disabled-tool",
    env: { BATCH_TOOLS_OFF: "1" },
    pidFile: scratchPath("run", "error-inventory-disabled-tool.pid")
  }).start();
  try {
    await session.handshake();
    const probe = session.request(
      "tools/call",
      { name: "batch-class-source", arguments: {} },
      { timeoutMs: 30_000 }
    );
    const reply = await probe.reply;
    const observed = classify(reply);
    const embedsCode = (reply.result?.content?.[0]?.text ?? "").includes("-32602");
    const ok = observed.classification === "isError-tool-result" && embedsCode;
    if (!ok) {
      failures += 1;
      console.error(`[disabled-tool] expected isError result embedding -32602, got ${JSON.stringify(reply).slice(0, 300)}`);
    } else {
      console.log(`[disabled-tool] successful isError CallToolResult embedding -32602 observed`);
    }
    entries.push({
      path: "disabled-tool",
      method: "tools/call",
      source: "live probe (this harness): BATCH_TOOLS_OFF=1, tools/call batch-class-source",
      env: { BATCH_TOOLS_OFF: "1" },
      embedsMinus32602InText: embedsCode,
      ...observed,
      reply: normalizeCaptured(reply)
    });
  } finally {
    await session.stop();
  }
}

// ---------------------------------------------------------------------------
// Codes extracted from the captured fixtures
// ---------------------------------------------------------------------------

function loadFixture(relativePath) {
  const path = join(FIXTURES_DIR, relativePath);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

const syntheticSources = [
  ["queue-overflow", "tools/call", "synthetic-shapes/overflow-toolscall.json", "reply"],
  ["queue-overflow", "resources/list", "synthetic-shapes/overflow-other.json", "reply"],
  ["worker-restart", "tools/call", "synthetic-shapes/restart-toolscall-structured.json", "reply"],
  ["worker-restart", "resources/list", "synthetic-shapes/restart-other-raw.json", "reply"],
  ["worker-restart-toggle-off", "tools/call", "synthetic-shapes/restart-toolscall-toggle-off.json", "reply"],
  ["validate-project-timeout", "tools/call", "synthetic-shapes/timeout-validate-project.json", "reply"],
  ["startup-failure-terminalization", "initialize", "synthetic-shapes/startup-failure-terminalization.json", "replies.initialize"],
  ["startup-failure-terminalization", "tools/call", "synthetic-shapes/startup-failure-terminalization.json", "replies.toolsCall"],
  ["startup-failure-terminalization", "resources/list", "synthetic-shapes/startup-failure-terminalization.json", "replies.other"]
];

for (const [path, method, file, replyPath] of syntheticSources) {
  const data = loadFixture(file);
  if (!data) {
    failures += 1;
    console.error(`[${path}/${method}] fixture missing: ${file} (run capture-synthetic-shapes.mjs first)`);
    continue;
  }
  let reply = data;
  for (const segment of replyPath.split(".")) reply = reply?.[segment];
  // Fixture replies are normalized; content text is {__normalizedJson: ...}.
  const structured = reply?.result?.structuredContent;
  const observed = reply?.error
    ? { wireCode: reply.error.code, problemCode: null, classification: "raw-jsonrpc-error" }
    : {
        wireCode: null,
        problemCode: structured?.error?.code ?? null,
        classification: reply?.result?.isError === true ? "isError-tool-result" : "success"
      };
  entries.push({
    path,
    method,
    source: `captured fixture: tests/fixtures/premigration/${file}`,
    ...observed
  });
  console.log(`[${path}/${method}] ${observed.classification} wireCode=${observed.wireCode} problemCode=${observed.problemCode}`);
}

// tool input validation (one entry per captured Zod-failure-kind golden)
const problemDetailsDir = join(FIXTURES_DIR, "problemdetails");
if (existsSync(problemDetailsDir)) {
  for (const file of readdirSync(problemDetailsDir).sort()) {
    const data = loadFixture(join("problemdetails", file));
    if (!data?.reply) continue;
    const structured = data.reply.result?.structuredContent;
    const isError = data.reply.result?.isError === true;
    entries.push({
      path: "tool-input-validation",
      method: "tools/call",
      zodFailureKind: data.zodFailureKind,
      tool: data.tool,
      source: `captured fixture: tests/fixtures/premigration/problemdetails/${file}`,
      wireCode: data.reply.error?.code ?? null,
      problemCode: structured?.error?.code ?? null,
      classification: isError ? "isError-tool-result" : "success"
    });
  }
} else {
  failures += 1;
  console.error("problemdetails fixtures missing (run capture-problemdetails.mjs first)");
}

// ---------------------------------------------------------------------------
// Summary + reserved-range assertion (no implementation-defined code in -32020..-32099)
// ---------------------------------------------------------------------------

const observedWireCodes = [...new Set(entries.map((entry) => entry.wireCode).filter((code) => code !== null))].sort((a, b) => a - b);
const inReservedRange = observedWireCodes.filter((code) => code <= -32020 && code >= -32099);
console.log(`observed raw JSON-RPC wire codes: ${JSON.stringify(observedWireCodes)}`);
if (inReservedRange.length > 0) {
  failures += 1;
  console.error(`FAILED: observed codes inside MCP-reserved -32020..-32099: ${inReservedRange}`);
}

if (failures > 0) {
  console.error(`FAILED: ${failures} inventory step(s) failed`);
  process.exit(1);
}

if (!validateOnly) {
  writeFixture("error-code-inventory.json", {
    description:
      "Pre-migration observed wire error-code inventory. Classification: raw-jsonrpc-error (JSON-RPC error envelope with wireCode) vs isError-tool-result (successful CallToolResult with isError:true carrying a ProblemDetails code). Reserved-range check: no observed wire code in -32020..-32099.",
    harness: "scripts/premigration/build-error-code-inventory.mjs",
    observedWireCodes,
    reservedRangeViolations: inReservedRange,
    entries
  });
  console.log("fixture written: error-code-inventory.json");
}
console.log("error-code inventory: OK");
