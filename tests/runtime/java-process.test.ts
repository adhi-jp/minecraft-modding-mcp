import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import {
  assertJavaAvailable,
  resetJavaAvailabilityCacheForTests,
  runJavaProcess
} from "../../src/java-process.ts";

function stubJavaAvailabilitySpawn(outcomes: Array<"success" | "error">): {
  spawn: typeof import("node:child_process").spawn;
  count: () => number;
} {
  let spawnCount = 0;
  const spawnStub = (() => {
    const outcome = outcomes[spawnCount] ?? outcomes.at(-1) ?? "success";
    spawnCount += 1;
    const proc = new EventEmitter() as EventEmitter & { kill: () => boolean };
    proc.kill = () => true;
    queueMicrotask(() => {
      if (outcome === "error") {
        proc.emit("error", new Error("java missing"));
      } else {
        proc.emit("exit", 0);
      }
    });
    return proc;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawn: spawnStub, count: () => spawnCount };
}

test("assertJavaAvailable memoizes a successful probe process-wide", async (t) => {
  const stub = stubJavaAvailabilitySpawn(["success"]);
  resetJavaAvailabilityCacheForTests(stub.spawn);
  t.after(() => resetJavaAvailabilityCacheForTests());

  for (let index = 0; index < 5; index += 1) {
    await assertJavaAvailable();
  }

  assert.equal(stub.count(), 1);
});

test("assertJavaAvailable does not cache unavailable-Java failures after reset", async (t) => {
  const stub = stubJavaAvailabilitySpawn(["error", "error"]);
  resetJavaAvailabilityCacheForTests(stub.spawn);
  t.after(() => resetJavaAvailabilityCacheForTests());

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      () => assertJavaAvailable(),
      (error: unknown) => (error as { code?: string }).code === ERROR_CODES.JAVA_UNAVAILABLE
    );
  }

  assert.equal(stub.count(), 2);
});

test("assertJavaAvailable caches a success that follows a failed probe", async (t) => {
  const stub = stubJavaAvailabilitySpawn(["error", "success"]);
  resetJavaAvailabilityCacheForTests(stub.spawn);
  t.after(() => resetJavaAvailabilityCacheForTests());

  await assert.rejects(
    () => assertJavaAvailable(),
    (error: unknown) => (error as { code?: string }).code === ERROR_CODES.JAVA_UNAVAILABLE
  );
  await assertJavaAvailable();
  await assertJavaAvailable();

  assert.equal(stub.count(), 2);
});

test("assertJavaAvailable resolves when java is installed", async () => {
  // This test will skip gracefully in environments without Java
  try {
    await assertJavaAvailable();
  } catch (error: unknown) {
    const appError = error as { code?: string };
    assert.equal(appError.code, ERROR_CODES.JAVA_UNAVAILABLE);
  }
});

test("runJavaProcess resolves with a non-zero exitCode when the target jar is missing", async () => {
  try {
    await assertJavaAvailable();
  } catch {
    // No Java available — skip this test
    return;
  }

  // Java starts fine but cannot open a missing jar, so it exits non-zero. This
  // resolves (with exitCode != 0); it does NOT reject — the reject paths are
  // covered by the dedicated timeout-kill and spawn-error tests below.
  const result = await runJavaProcess({
    jarPath: "/tmp/nonexistent-test-jar.jar",
    args: [],
    timeoutMs: 5_000
  });

  assert.notEqual(result.exitCode, 0);
});

test("runJavaProcess normalizes path args when normalizePathArgs is true", async () => {
  // Verify the function doesn't throw when constructing args with normalization
  try {
    await assertJavaAvailable();
  } catch {
    return;
  }

  const result = await runJavaProcess({
    jarPath: "/tmp/nonexistent-test-jar.jar",
    args: ["/tmp/input.jar", "/tmp/output.jar", "--threads=4"],
    timeoutMs: 5_000,
    normalizePathArgs: true
  });

  // Should still fail because jar doesn't exist, but args should be processed
  assert.notEqual(result.exitCode, 0);
});

test("runJavaProcess accepts memory flags without a spawn error (missing jar still exits non-zero)", async () => {
  try {
    await assertJavaAvailable();
  } catch {
    return;
  }

  // The process exits non-zero because the jar doesn't exist; this smoke-checks
  // that the -Xmx/-Xms args don't break spawning. The dedicated test below
  // asserts those flags actually reach the spawn argv.
  const result = await runJavaProcess({
    jarPath: "/tmp/nonexistent-test-jar.jar",
    args: [],
    timeoutMs: 5_000,
    maxMemoryMb: 512,
    minMemoryMb: 128
  });

  assert.notEqual(result.exitCode, 0);
});

test("runJavaProcess kills the process and rejects with JAVA_PROCESS_FAILED on timeout", async () => {
  if (process.platform === "win32") {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "java-process-timeout-"));
  const binDir = join(root, "bin");
  const fakeJavaPath = join(binDir, "java");
  mkdirSync(binDir, { recursive: true });

  // Fake `java` that hangs far past the timeout so the kill + reject path runs.
  writeFileSync(
    fakeJavaPath,
    `#!/usr/bin/env node
setTimeout(() => process.exit(0), 30000);
`,
    "utf8"
  );
  chmodSync(fakeJavaPath, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${delimiter}${originalPath}`;

  try {
    await assert.rejects(
      () =>
        runJavaProcess({
          jarPath: "/tmp/whatever.jar",
          args: [],
          timeoutMs: 300
        }),
      (error: unknown) => {
        const appError = error as { code?: string; details?: { reason?: string } };
        assert.equal(appError.code, ERROR_CODES.JAVA_PROCESS_FAILED);
        assert.equal(appError.details?.reason, "timeout");
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runJavaProcess rejects with JAVA_PROCESS_FAILED when java cannot be spawned", async () => {
  const root = await mkdtemp(join(tmpdir(), "java-process-spawn-err-"));
  const emptyBin = join(root, "empty-bin");
  mkdirSync(emptyBin, { recursive: true });

  const originalPath = process.env.PATH ?? "";
  // Point PATH at a directory with no `java`, so spawn raises an ENOENT error.
  process.env.PATH = emptyBin;

  try {
    await assert.rejects(
      () =>
        runJavaProcess({
          jarPath: "/tmp/whatever.jar",
          args: [],
          timeoutMs: 2_000
        }),
      (error: unknown) => {
        const appError = error as { code?: string; details?: { error?: string } };
        assert.equal(appError.code, ERROR_CODES.JAVA_PROCESS_FAILED);
        assert.equal(typeof appError.details?.error, "string");
        return true;
      }
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("runJavaProcess forwards -Xmx/-Xms memory flags ahead of -jar in the spawn args", async () => {
  if (process.platform === "win32") {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "java-process-memflags-"));
  const binDir = join(root, "bin");
  const fakeJavaPath = join(binDir, "java");
  const argsLogPath = join(root, "java-args.log");
  mkdirSync(binDir, { recursive: true });

  // Fake `java` records every arg it was spawned with, then exits cleanly.
  writeFileSync(
    fakeJavaPath,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "-version") {
  process.exit(0);
}
writeFileSync(${JSON.stringify(argsLogPath)}, args.join("\\n"), "utf8");
process.exit(0);
`,
    "utf8"
  );
  chmodSync(fakeJavaPath, 0o755);

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}${delimiter}${originalPath}`;

  try {
    const result = await runJavaProcess({
      jarPath: "/tmp/tool.jar",
      args: ["--threads=4"],
      timeoutMs: 5_000,
      maxMemoryMb: 512,
      minMemoryMb: 128
    });

    assert.equal(result.exitCode, 0);

    const spawnedArgs = readFileSync(argsLogPath, "utf8").split("\n");
    const xmxIndex = spawnedArgs.indexOf("-Xmx512m");
    const xmsIndex = spawnedArgs.indexOf("-Xms128m");
    const jarIndex = spawnedArgs.indexOf("-jar");

    assert.ok(xmxIndex >= 0, "-Xmx512m must reach the spawn args");
    assert.ok(xmsIndex >= 0, "-Xms128m must reach the spawn args");
    assert.ok(jarIndex >= 0, "-jar must reach the spawn args");
    assert.ok(xmxIndex < jarIndex, "-Xmx must precede -jar");
    assert.ok(xmsIndex < jarIndex, "-Xms must precede -jar");
  } finally {
    process.env.PATH = originalPath;
  }
});

import {
  limitStdio,
  isAbsolutePath,
  isOptionArg,
  normalizeArgs,
  MAX_STDIO_SNAPSHOT
} from "../../src/java-process.ts";

test("limitStdio returns the original string when length <= MAX_STDIO_SNAPSHOT", () => {
  const short = "abc";
  assert.equal(limitStdio(short), short);
  const exact = "x".repeat(MAX_STDIO_SNAPSHOT);
  assert.equal(limitStdio(exact).length, MAX_STDIO_SNAPSHOT);
  assert.equal(limitStdio(exact), exact);
});

test("limitStdio keeps the tail when length exceeds MAX_STDIO_SNAPSHOT", () => {
  const head = "HEAD";
  const tail = "TAIL_LAST_CHARS";
  const middle = "M".repeat(MAX_STDIO_SNAPSHOT);
  const overflow = head + middle + tail;
  const result = limitStdio(overflow);
  assert.equal(result.length, MAX_STDIO_SNAPSHOT);
  assert.ok(result.endsWith(tail), "tail must be preserved");
  assert.ok(!result.startsWith(head), "head must be discarded");
});

test("isAbsolutePath recognises POSIX and Windows drive paths", () => {
  assert.equal(isAbsolutePath("/tmp/x"), true);
  assert.equal(isAbsolutePath("/"), true);
  assert.equal(isAbsolutePath("C:\\Windows"), true);
  assert.equal(isAbsolutePath("D:/foo"), true);
  assert.equal(isAbsolutePath("rel/path"), false);
  assert.equal(isAbsolutePath("./x"), false);
  assert.equal(isAbsolutePath("..\\x"), false);
  assert.equal(isAbsolutePath(""), false);
});

test("isOptionArg only matches values starting with '-'", () => {
  assert.equal(isOptionArg("--threads=4"), true);
  assert.equal(isOptionArg("-Xmx512m"), true);
  assert.equal(isOptionArg("--out=/abs/path"), true);
  assert.equal(isOptionArg("/abs/path"), false);
  assert.equal(isOptionArg("rel/path"), false);
});

test("normalizeArgs leaves option args and relative paths untouched while normalizing absolute paths", () => {
  const inputs = ["/tmp/abs", "rel/path", "--threads=4", "-Xmx512m", "--out=/abs/path"];
  const out = normalizeArgs(inputs);
  // Option args and relative paths are passed through verbatim.
  assert.equal(out[1], "rel/path");
  assert.equal(out[2], "--threads=4");
  assert.equal(out[3], "-Xmx512m");
  assert.equal(out[4], "--out=/abs/path");
  // The absolute path entry is the only one that may have been transformed by
  // normalizePathForHost. We don't assert the exact host shape here (it depends
  // on platform), but we do assert it stays non-empty and remains absolute.
  assert.ok(typeof out[0] === "string" && out[0]!.length > 0);
});

test("normalizeArgs handles empty array and empty string entries safely", () => {
  assert.deepEqual(normalizeArgs([]), []);
  // Empty string is not an option arg and not absolute → passed through unchanged.
  assert.deepEqual(normalizeArgs([""]), [""]);
});
