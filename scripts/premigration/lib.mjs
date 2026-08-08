/**
 * Shared harness library for the pre-migration baseline captures.
 *
 * Talks to the PRODUCTION server (`node --import tsx src/cli.ts`, i.e. the
 * stdio supervisor + worker pair) over newline-delimited JSON-RPC exactly like
 * a legacy 2025-11-25 client, and freezes normalized fixtures under
 * tests/fixtures/premigration/.
 *
 * NORMALIZATION RULES (applied by normalizeCaptured / writeFixture; also
 * documented in tests/fixtures/premigration/README.md — keep in sync):
 *  N1. JSON object keys are sorted recursively (stable byte order), EXCEPT
 *      subtrees explicitly marked verbatim (tool-contract `inputSchema`
 *      subtrees keep wire property order for legacy byte comparison).
 *  N2. Machine-specific path prefixes in strings are replaced: repo root ->
 *      "<REPO>", the harness scratch directory -> "<SCRATCH>", the user home
 *      directory -> "<HOME>".
 *  N3. Non-deterministic values are replaced by key name:
 *        requestId                    -> "<REQUEST_ID>"   (server-random id)
 *        durationMs, lastStageElapsedMs, elapsedMs -> "<DURATION_MS>"
 *        startedAt, lastStageStartedAt -> "<TIMESTAMP>"
 *        pid                          -> "<PID>"
 *      plus `instance` values matching the server's random request-id pattern
 *      /^[0-9a-z]+-[0-9a-z]{8}$/ -> "<REQUEST_ID>". `instance` values of the
 *      form urn:mcp:request:<n> are NOT replaced: the harness uses fixed
 *      sequential JSON-RPC ids, so they are deterministic.
 *  N4. `content[*].text` strings that parse as JSON are replaced by
 *      {"__normalizedJson": <parsed-and-normalized value>} so the text blob
 *      and structuredContent normalize identically (the live server emits
 *      text === JSON.stringify(structuredContent)).
 *  N5. Every fixture records the environment variables that select behavior
 *      (`env` field), with scratch paths normalized per N2. Fixtures contain
 *      no capture timestamps; the capture date/commit live in the README.
 */

import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES_DIR = join(REPO_ROOT, "tests", "fixtures", "premigration");

/** Scratch root for server caches/pid files; overridable, never the repo. */
export const SCRATCH_ROOT =
  process.env.PREMIGRATION_SCRATCH ?? join(tmpdir(), "premigration-p1-0");

export function scratchPath(...parts) {
  const p = join(SCRATCH_ROOT, ...parts);
  mkdirSync(p.endsWith(".pid") || p.includes(".") ? dirname(p) : p, { recursive: true });
  return p;
}

export function gitHead() {
  return execSync("git rev-parse HEAD", { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const DURATION_KEYS = new Set([
  "durationMs",
  "lastStageElapsedMs",
  "elapsedMs",
  // runtime-metrics latency aggregates (wall-clock dependent)
  "avgMs",
  "lastMs",
  "minMs",
  "maxMs",
  "p95Ms",
  "p99Ms",
  "totalMs"
]);
const TIMESTAMP_KEYS = new Set(["startedAt", "lastStageStartedAt"]);
const RANDOM_REQUEST_ID_RE = /^[0-9a-z]+-[0-9a-z]{8}$/;

function normalizeString(value, ctx) {
  let out = value;
  // Longest prefix first so <SCRATCH> under the home dir wins over <HOME>.
  for (const [prefix, placeholder] of ctx.pathReplacements) {
    out = out.split(prefix).join(placeholder);
  }
  return out;
}

/**
 * Recursively normalize a captured JSON value per rules N1-N4.
 * `verbatimKeys`: object keys whose subtree keeps property order and raw
 * strings (rule N1 exception; used for advertised inputSchema bytes).
 */
export function normalizeCaptured(value, options = {}) {
  const ctx = {
    pathReplacements: options.pathReplacements ?? defaultPathReplacements(),
    verbatimKeys: new Set(options.verbatimKeys ?? [])
  };
  return normalizeNode(value, ctx, undefined, false);
}

function normalizeNode(value, ctx, keyName, verbatim) {
  if (typeof value === "string") {
    if (!verbatim) {
      if (keyName === "requestId" && RANDOM_REQUEST_ID_RE.test(value)) return "<REQUEST_ID>";
      if (keyName === "instance" && RANDOM_REQUEST_ID_RE.test(value)) return "<REQUEST_ID>";
      if (keyName === "text") {
        const parsed = tryParseJson(value);
        if (parsed !== undefined) {
          return { __normalizedJson: normalizeNode(parsed, ctx, undefined, false) };
        }
      }
    }
    return normalizeString(value, ctx);
  }
  if (typeof value === "number") {
    if (!verbatim) {
      if (keyName !== undefined && DURATION_KEYS.has(keyName)) return "<DURATION_MS>";
      if (keyName !== undefined && TIMESTAMP_KEYS.has(keyName)) return "<TIMESTAMP>";
      if (keyName === "pid") return "<PID>";
    }
    return value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeNode(entry, ctx, undefined, verbatim));
  }
  const keys = verbatim ? Object.keys(value) : Object.keys(value).sort();
  const result = {};
  for (const key of keys) {
    const childVerbatim = verbatim || ctx.verbatimKeys.has(key);
    result[key] = normalizeNode(value[key], ctx, key, childVerbatim);
  }
  return result;
}

function tryParseJson(text) {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function defaultPathReplacements() {
  // Order matters: longest / most specific prefixes first (rule N2).
  const entries = [
    [SCRATCH_ROOT, "<SCRATCH>"],
    [REPO_ROOT, "<REPO>"],
    [homedir(), "<HOME>"]
  ];
  return entries.sort((a, b) => b[0].length - a[0].length);
}

/** Normalize an env record for fixture embedding (paths only; rule N5). */
export function normalizeEnvForFixture(env) {
  const out = {};
  for (const key of Object.keys(env).sort()) {
    out[key] = normalizeCaptured(env[key]);
  }
  return out;
}

export function writeFixture(relativePath, data) {
  const target = join(FIXTURES_DIR, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return target;
}

// ---------------------------------------------------------------------------
// Server session (legacy newline-delimited JSON-RPC client)
// ---------------------------------------------------------------------------

export const LEGACY_PROTOCOL_VERSION = "2025-11-25";

/**
 * A production-server session. Spawns `node --import tsx src/cli.ts` from the
 * repo root (the real supervisor entry; the supervisor spawns the worker with
 * the same execArgv). Client traffic is newline-delimited JSON-RPC.
 */
export class ServerSession {
  constructor({ label, env = {}, pidFile } = {}) {
    this.label = label ?? "session";
    this.extraEnv = env;
    this.pidFile = pidFile;
    this.nextId = 1;
    this.pendingReplies = new Map(); // id -> {resolve}
    this.messages = []; // every parsed message from server stdout, in order
    this.stderr = "";
    this.exited = false;
    this.child = undefined;
    this.buffer = "";
    this.messageListeners = new Set();
  }

  baseEnv() {
    return {
      ...process.env,
      MCP_CACHE_DIR: scratchPath("cache"),
      MCP_SQLITE_PATH: join(scratchPath("cache"), "source-cache.db"),
      ...(this.pidFile ? { MCP_SUPERVISOR_CHILD_PID_FILE: this.pidFile } : {}),
      ...this.extraEnv
    };
  }

  /** Env vars that select server behavior, for fixture recording (rule N5). */
  recordedEnv() {
    const record = {
      MCP_CACHE_DIR: scratchPath("cache"),
      MCP_SQLITE_PATH: join(scratchPath("cache"), "source-cache.db"),
      ...(this.pidFile ? { MCP_SUPERVISOR_CHILD_PID_FILE: this.pidFile } : {}),
      ...this.extraEnv
    };
    return normalizeEnvForFixture(record);
  }

  start() {
    this.child = spawn(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "src", "cli.ts")],
      {
        cwd: REPO_ROOT,
        env: this.baseEnv(),
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString();
    });
    this.child.once("exit", () => {
      this.exited = true;
    });
    return this;
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // non-JSON stdout noise would be a bug; ignore for capture
      }
      this.messages.push(message);
      const id = message.id;
      if ((typeof id === "string" || typeof id === "number") && this.pendingReplies.has(String(id))) {
        const waiter = this.pendingReplies.get(String(id));
        this.pendingReplies.delete(String(id));
        waiter.resolve(message);
      }
      for (const listener of [...this.messageListeners]) listener(message);
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Send a request with the next sequential id; returns {id, reply: Promise}. */
  request(method, params, { timeoutMs = 30_000 } = {}) {
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) };
    const reply = this.waitForReply(id, timeoutMs, method);
    this.send(message);
    return { id, request: message, reply };
  }

  waitForReply(id, timeoutMs, methodLabel = "") {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(String(id));
        rejectPromise(
          new Error(`[${this.label}] timeout waiting for reply id=${id} ${methodLabel}`)
        );
      }, timeoutMs);
      timer.unref?.();
      this.pendingReplies.set(String(id), {
        resolve: (message) => {
          clearTimeout(timer);
          resolvePromise(message);
        }
      });
    });
  }

  async handshake({ clientName = "premigration-harness" } = {}) {
    const init = this.request("initialize", {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "0.0.0" }
    });
    const reply = await init.reply;
    if (reply.error) {
      throw new Error(`[${this.label}] initialize failed: ${JSON.stringify(reply.error)}`);
    }
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return reply;
  }

  readWorkerPid() {
    if (!this.pidFile || !existsSync(this.pidFile)) return undefined;
    const raw = readFileSync(this.pidFile, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  async waitForWorkerReady({ timeoutMs = 60_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // The supervisor consumes the READY marker line itself; observe readiness
    // via the pid file plus a successful round-trip instead.
    while (Date.now() < deadline) {
      const pid = this.readWorkerPid();
      if (pid !== undefined && isProcessAlive(pid)) return pid;
      await sleep(50);
    }
    throw new Error(`[${this.label}] worker never became ready`);
  }

  signalWorker(signal) {
    const pid = this.readWorkerPid();
    if (pid === undefined) throw new Error(`[${this.label}] no worker pid recorded`);
    process.kill(pid, signal);
    return pid;
  }

  /** Graceful stop (stdin close -> supervisor shutdown kills worker group), then hard kill. */
  async stop() {
    const workerPid = this.readWorkerPid();
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const deadline = Date.now() + 5_000;
    while (!this.exited && Date.now() < deadline) {
      await sleep(50);
    }
    if (!this.exited) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    // Belt and braces: the worker runs detached in its own process group.
    if (workerPid !== undefined) {
      for (const target of [-workerPid, workerPid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          /* ESRCH: already dead — the normal case */
        }
      }
    }
    await sleep(100);
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// Flag configurations (tools/list membership)
// ---------------------------------------------------------------------------

export const FLAG_CONFIGS = [
  { name: "default", env: {} },
  { name: "verify-mixin-target-off", env: { VERIFY_MIXIN_TARGET_OFF: "1" } },
  { name: "batch-tools-off", env: { BATCH_TOOLS_OFF: "1" } },
  { name: "both-off", env: { VERIFY_MIXIN_TARGET_OFF: "1", BATCH_TOOLS_OFF: "1" } }
];

export const VERIFY_MIXIN_TARGET_TOOL = "verify-mixin-target";
export const BATCH_TOOLS = [
  "batch-class-source",
  "batch-class-members",
  "batch-symbol-exists",
  "batch-mappings"
];

/** Expected membership for a flag config, derived from the pinned EXPECTED_TOOLS. */
export function expectedToolsForConfig(expectedTools, flagEnv) {
  let names = [...expectedTools];
  if (flagEnv.VERIFY_MIXIN_TARGET_OFF === "1") {
    names = names.filter((name) => name !== VERIFY_MIXIN_TARGET_TOOL);
  }
  if (flagEnv.BATCH_TOOLS_OFF === "1") {
    names = names.filter((name) => !BATCH_TOOLS.includes(name));
  }
  return names;
}
