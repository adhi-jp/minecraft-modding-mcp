import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as supervisorModule from "../../src/stdio-supervisor.ts";

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("POSIX process-group termination removes a worker and its descendant", { timeout: 5_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX process groups are not available on Windows");
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
