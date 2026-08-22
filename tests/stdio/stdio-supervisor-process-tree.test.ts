import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as supervisorModule from "../../src/stdio-supervisor.ts";
import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("POSIX process-group termination removes a worker and its descendant", { timeout: 5_000 }, async (t) => {
  if (await skipWithoutCapability(t, "posix-process-groups")) {
    return;
  }
  const terminate = (supervisorModule as Record<string, unknown>).terminatePosixProcessGroup;
  assert.equal(typeof terminate, "function");

  const root = await mkdtemp(join(tmpdir(), "stdio-supervisor-tree-"));
  const pidFile = join(root, "descendant.pid");
  t.after(() => rm(root, { recursive: true, force: true }));

  const worker = spawn(
    process.execPath,
    ["-e", "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);writeFileSync(process.argv[1],String(c.pid));setInterval(()=>{},1000);", pidFile],
    { detached: true, stdio: "ignore" }
  );
  t.after(() => {
    // allow-direct-sigkill: safety net over a SYNTHETIC detached process group; nothing here runs a shutdown path
    try { process.kill(-(worker.pid ?? 0), "SIGKILL"); } catch { /* already gone */ }
  });
  let descendantPid: number | undefined;
  const reportDeadline = Date.now() + 1_000;
  while (Date.now() < reportDeadline && descendantPid === undefined) {
    descendantPid = await readFile(pidFile, "utf8").then((value) => Number(value.trim()), () => undefined);
    if (descendantPid === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(typeof descendantPid, "number", "descendant PID was not reported");

  assert.equal(
    (terminate as (pid: number, kill?: typeof process.kill) => boolean)(worker.pid ?? 0),
    true
  );
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && (await processExists(worker.pid ?? 0) || await processExists(descendantPid ?? 0))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await processExists(worker.pid ?? 0), false);
  assert.equal(await processExists(descendantPid ?? 0), false);
});

/**
 * Defence in depth for the stdin-EOF self-exit: a host may hand the worker a
 * stdin that never reaches EOF when its parent dies (anything that is not a
 * pipe the parent solely owns). The worker therefore also polls its parent's
 * LIVENESS and stands down when the parent is gone.
 *
 * The rig below reproduces exactly that shape. A launcher opens a FIFO
 * O_RDWR and hands the descriptor to a detached worker as fd 0: because the
 * same open file description is both reader and writer, the FIFO can never
 * signal EOF, so killing the launcher leaves the worker with a perfectly
 * healthy stdin and no parent. `process.ppid` is a static data property in
 * node, so the worker cannot observe reparenting by re-reading it — only by
 * probing whether the pid it snapshotted at startup is still alive.
 *
 * The rig's own positive control is the worker's stand-down DIAGNOSTIC, not
 * the fact that it died: an ordinary pipe would EOF the moment the launcher
 * was killed and the worker would stand down through the stdin route that
 * stdio-worker-protocol.test.ts already covers, leaving the liveness poll
 * unproven while every liveness-shaped assertion still passed. Capturing the
 * worker's stderr and requiring the parent-liveness event — reporting that
 * stdin had NOT ended — is what fails if the FIFO ever degenerates into a
 * plain pipe.
 */
test("worker on a never-EOF stdin still stands down once its parent process dies", { timeout: 90_000 }, async (t) => {
  if (await skipWithoutCapability(t, "posix-shell-bridge")) {
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "worker-parent-liveness-"));
  const fifoPath = join(root, "worker-stdin.fifo");
  const pidFile = join(root, "worker.pid");
  const workerLogPath = join(root, "worker.stderr.log");
  t.after(() => rm(root, { recursive: true, force: true }));
  await new Promise<void>((resolve, reject) => {
    const mkfifo = spawn("mkfifo", [fifoPath], { stdio: "ignore" });
    mkfifo.once("error", reject);
    mkfifo.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`mkfifo exited ${String(code)}`))));
  });

  const launcher = spawn(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const{spawn}=require('node:child_process');" +
        "const fd=fs.openSync(process.argv[1],fs.constants.O_RDWR);" +
        "const errFd=fs.openSync(process.argv[2],'a');" +
        "const c=spawn(process.execPath,['--import','tsx','src/cli.ts']," +
        "{cwd:process.cwd(),env:process.env,stdio:[fd,'ignore',errFd],detached:true});" +
        "c.unref();setInterval(()=>{},1000);",
      fifoPath,
      workerLogPath
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MCP_STDIO_WORKER_MODE: "1",
        MCP_SUPERVISOR_CHILD_PID_FILE: pidFile,
        MCP_CACHE_DIR: join(root, "cache"),
        MCP_SQLITE_PATH: join(root, "cache", "source-cache.db")
      },
      stdio: "ignore"
    }
  );

  let workerPid: number | undefined;
  const pidDeadline = Date.now() + 30_000;
  while (Date.now() < pidDeadline && workerPid === undefined) {
    workerPid = await readFile(pidFile, "utf8").then((value) => Number(value.trim()) || undefined, () => undefined);
    if (workerPid === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(typeof workerPid, "number", "the worker never reported its pid");
  t.after(() => {
    try { process.kill(workerPid ?? 0, "SIGTERM"); } catch { /* already gone */ }
  });

  // With the parent still alive the worker must survive. This half is NOT a
  // rig self-check: while the launcher holds the descriptor open no stdin
  // configuration can EOF, so a plain pipe would pass it identically. The
  // discriminating assertion is on the stand-down diagnostic, after the kill.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(await processExists(workerPid ?? 0), true, "the worker must survive while its parent lives");

  // Kill the parent OUTRIGHT — an abrupt parent death with no shutdown path
  // is the scenario; a cooperative stop would prove nothing.
  launcher.kill("SIGKILL"); // allow-direct-sigkill: the launcher's abrupt, unhandled death IS the scenario under test
  await new Promise<void>((resolve) => {
    if (launcher.exitCode !== null || launcher.signalCode !== null) { resolve(); return; }
    launcher.once("exit", () => resolve());
  });

  const exitDeadline = Date.now() + 45_000;
  while (Date.now() < exitDeadline && (await processExists(workerPid ?? 0))) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(
    await processExists(workerPid ?? 0),
    false,
    "the worker must stand down after its parent died, even on a stdin that never reaches EOF"
  );

  // The positive control. Only the parent-liveness poll writes this event, and
  // only a stdin that never reached EOF can leave `stdinEnded: false` on it.
  // A rig degraded to `stdio: ['pipe', ...]` stands the worker down through
  // stdin EOF within milliseconds of the kill and never reaches this arm, so
  // both assertions below fail rather than silently proving the wrong path.
  const workerLog = await readFile(workerLogPath, "utf8").catch(() => "");
  const standDown = workerLog
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((entry) => entry?.event === "worker.parent_liveness_lost");
  assert.ok(
    standDown,
    `the worker must stand down through the parent-liveness poll, not stdin EOF; worker stderr was:\n${workerLog}`
  );
  assert.equal(
    standDown.stdinEnded,
    false,
    "the rig's stdin must never have reached EOF, or this test is proving the stdin-EOF path"
  );
});
