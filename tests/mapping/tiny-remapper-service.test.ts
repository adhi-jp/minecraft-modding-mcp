import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../src/errors.ts";
import { remapJar, type RemapOptions } from "../../src/tiny-remapper-service.ts";
import { mockJavaRunner } from "../helpers/java-runner-mock.ts";
import { skipWithoutCapability } from "../helpers/runtime-capabilities.ts";

test("remapJar surfaces JAVA_PROCESS_FAILED / REMAP_FAILED when the tiny-remapper jar is missing (real-spawn smoke)", async (t) => {
  // This test exercises the real `spawn` path, so it requires a working Java
  // runtime. Skip through the declared capability instead of silently returning
  // when Java is unavailable: the test would otherwise appear "green" without
  // Java, and the named-test set gate needs the capability name to report WHY
  // this frozen row went unproven.
  if (await skipWithoutCapability(t, "java-runtime")) {
    return;
  }

  const options: RemapOptions = {
    inputJar: "/tmp/nonexistent-input.jar",
    outputJar: "/tmp/nonexistent-output.jar",
    mappingsFile: "/tmp/nonexistent-mappings.tiny",
    fromNamespace: "intermediary",
    toNamespace: "named"
  };

  await assert.rejects(
    () => remapJar("/tmp/nonexistent-remapper.jar", options),
    (error: unknown) => {
      const appError = error as { code?: string };
      return (
        appError.code === ERROR_CODES.JAVA_PROCESS_FAILED ||
        appError.code === ERROR_CODES.REMAP_FAILED
      );
    }
  );
});

test("remapJar invokes javaRunner via mockJavaRunner helper (mock smoke)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "remap-smoke-"));
  const inputJar = join(root, "in.jar");
  const outputJar = join(root, "out.jar");
  const mappings = join(root, "mappings.tiny");
  await writeFile(inputJar, Buffer.from("PK\x03\x04"));
  await writeFile(mappings, "tiny\t2\t0\tintermediary\tnamed\n");

  const recording = mockJavaRunner(async () => {
    await writeFile(outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  const result = await remapJar("/tmp/fake-remapper.jar", {
    inputJar,
    outputJar,
    mappingsFile: mappings,
    fromNamespace: "intermediary",
    toNamespace: "named"
  });

  assert.equal(result.outputJar, outputJar);
  assert.equal(recording.calls.length, 1);
  assert.equal(recording.calls[0]!.jarPath, "/tmp/fake-remapper.jar");
  assert.deepEqual(recording.calls[0]!.args, [
    inputJar,
    outputJar,
    mappings,
    "intermediary",
    "named"
  ]);
});

async function buildRemapFixture(prefix: string): Promise<{
  root: string;
  inputJar: string;
  outputJar: string;
  mappings: string;
  base: RemapOptions;
}> {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const inputJar = join(root, "in.jar");
  const outputJar = join(root, "out.jar");
  const mappings = join(root, "mappings.tiny");
  await writeFile(inputJar, Buffer.from("PK\x03\x04"));
  await writeFile(mappings, "tiny\t2\t0\tintermediary\tnamed\n");
  return {
    root,
    inputJar,
    outputJar,
    mappings,
    base: {
      inputJar,
      outputJar,
      mappingsFile: mappings,
      fromNamespace: "intermediary",
      toNamespace: "named"
    }
  };
}

test("remapJar omits --threads when threads defaults to 4 and omits --rebuildSourceFilenames when false", async () => {
  const fx = await buildRemapFixture("remap-default-threads");
  const recording = mockJavaRunner(async () => {
    await writeFile(fx.outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  await remapJar("/tmp/fake-remapper.jar", fx.base);

  const args = recording.calls[0]!.args;
  assert.deepEqual(args, [
    fx.inputJar,
    fx.outputJar,
    fx.mappings,
    "intermediary",
    "named"
  ]);
  assert.ok(!args.some((a) => a.startsWith("--threads")));
  assert.ok(!args.includes("--rebuildSourceFilenames"));
});

test("remapJar appends --threads=N for non-default threads and --rebuildSourceFilenames when true", async () => {
  const fx = await buildRemapFixture("remap-custom-flags");
  const recording = mockJavaRunner(async () => {
    await writeFile(fx.outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  await remapJar("/tmp/fake-remapper.jar", {
    ...fx.base,
    threads: 8,
    rebuildSourceFilenames: true
  });

  const args = recording.calls[0]!.args;
  assert.deepEqual(args, [
    fx.inputJar,
    fx.outputJar,
    fx.mappings,
    "intermediary",
    "named",
    "--threads=8",
    "--rebuildSourceFilenames"
  ]);
});

test("remapJar propagates default timeoutMs / maxMemoryMb and normalizePathArgs to javaRunner.run", async () => {
  const fx = await buildRemapFixture("remap-defaults-propagate");
  const recording = mockJavaRunner(async () => {
    await writeFile(fx.outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  await remapJar("/tmp/fake-remapper.jar", fx.base);

  const opts = recording.calls[0]!;
  assert.equal(opts.timeoutMs, 600_000);
  assert.equal(opts.maxMemoryMb, 4096);
  assert.equal(opts.normalizePathArgs, true);
  assert.equal(opts.jarPath, "/tmp/fake-remapper.jar");
});

test("remapJar forwards explicit timeoutMs / maxMemoryMb overrides", async () => {
  const fx = await buildRemapFixture("remap-overrides");
  const recording = mockJavaRunner(async () => {
    await writeFile(fx.outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  await remapJar("/tmp/fake-remapper.jar", {
    ...fx.base,
    timeoutMs: 30_000,
    maxMemoryMb: 1024
  });

  const opts = recording.calls[0]!;
  assert.equal(opts.timeoutMs, 30_000);
  assert.equal(opts.maxMemoryMb, 1024);
});

test("remapJar throws REMAP_FAILED with details when exit code is non-zero", async () => {
  const fx = await buildRemapFixture("remap-exit-nonzero");
  mockJavaRunner(async () => ({
    exitCode: 1,
    stdoutTail: "",
    stderrTail: "tiny-remapper error: bad mapping"
  }));

  await assert.rejects(
    () => remapJar("/tmp/fake-remapper.jar", fx.base),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.REMAP_FAILED);
      assert.equal(err.details?.exitCode, 1);
      assert.match(err.details?.stderrTail ?? "", /bad mapping/);
      assert.equal(err.details?.inputJar, fx.inputJar);
      assert.equal(err.details?.outputJar, fx.outputJar);
      return true;
    }
  );
});

test("remapJar throws REMAP_FAILED when exit code is zero but no output JAR is produced", async () => {
  const fx = await buildRemapFixture("remap-no-output");
  mockJavaRunner(async () => ({
    exitCode: 0,
    stdoutTail: "",
    stderrTail: ""
  }));

  await assert.rejects(
    () => remapJar("/tmp/fake-remapper.jar", fx.base),
    (err: any) => {
      assert.equal(err.code, ERROR_CODES.REMAP_FAILED);
      assert.match(err.message ?? "", /did not produce/);
      return true;
    }
  );
});

test("remapJar returns RemapResult with durationMs >= 0 on success", async () => {
  const fx = await buildRemapFixture("remap-success");
  mockJavaRunner(async () => {
    await writeFile(fx.outputJar, Buffer.from("PK\x03\x04"));
    return { exitCode: 0, stdoutTail: "", stderrTail: "" };
  });

  const result = await remapJar("/tmp/fake-remapper.jar", fx.base);
  assert.equal(result.outputJar, fx.outputJar);
  assert.equal(typeof result.durationMs, "number");
  assert.ok(result.durationMs >= 0);
});

test("remapJar propagates assertJavaAvailable failures with their original code", async () => {
  const fx = await buildRemapFixture("remap-no-java");
  mockJavaRunner(
    async () => {
      throw new Error("javaRunner.run must not be invoked when assertAvailable rejects");
    },
    async () => {
      throw Object.assign(new Error("java missing"), { code: ERROR_CODES.JAVA_UNAVAILABLE });
    }
  );

  await assert.rejects(
    () => remapJar("/tmp/fake-remapper.jar", fx.base),
    (err: any) => err.code === ERROR_CODES.JAVA_UNAVAILABLE
  );
});
