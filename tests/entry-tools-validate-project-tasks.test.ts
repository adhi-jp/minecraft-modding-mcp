import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ValidateProjectService } from "../src/entry-tools/validate-project-service.ts";

type Result = Record<string, unknown> & { warnings?: string[]; tasks?: Record<string, Record<string, unknown>> };

async function makeWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeBareGradleWorkspace(root: string): Promise<void> {
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  await writeFile(join(root, "build.gradle"), "// nothing\n", "utf8");
}

test("validate-project tasks A1: all probes ok when workspace, gradle, artifact, and discovery succeed", async () => {
  const root = await makeWorkspace("validate-project-tasks-a1-");
  await writeBareGradleWorkspace(root);
  const mixinPath = join(root, "demo.mixins.json");
  await writeFile(mixinPath, JSON.stringify({ package: "demo.mixin", mixins: ["DemoMixin"] }), "utf8");

  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 1, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => ({ valid: true, header: "accessWidener v2 named", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [mixinPath],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    resolveArtifact: async () => ({ artifactId: "minecraft-1.21.10", mappingApplied: "obfuscated", warnings: [] })
  });

  const result = (await service.execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;

  assert.ok(result.tasks, "tasks field should be present");
  const tasks = result.tasks!;
  assert.equal(tasks["workspace.detected"].status, "ok");
  assert.equal(tasks["gradle.readable"].status, "ok");
  assert.equal(tasks["minecraft.artifact.resolved"].status, "ok");
  assert.equal(tasks["mixins.validated"].status, "ok");
  assert.equal(tasks["accessWideners.validated"].status, "missing");
  assert.equal(tasks["accessTransformers.validated"].status, "missing");
  assert.equal(result.summary.status, "ok");
});

test("validate-project tasks A2: workspace.detected missing causes downstream skipped, headline blocked preserved", async () => {
  const empty = await makeWorkspace("validate-project-tasks-a2-");
  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 0, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => []
  });

  const result = (await service.execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    preferProjectVersion: true,
    subject: { kind: "workspace", projectPath: empty }
  })) as Result;

  assert.ok(result.tasks);
  const tasks = result.tasks!;
  assert.equal(tasks["workspace.detected"].status, "missing");
  assert.equal(tasks["gradle.readable"].status, "skipped");
  assert.equal(tasks["minecraft.artifact.resolved"].status, "skipped");
  assert.equal(tasks["mixins.validated"].status, "skipped");
  assert.equal(tasks["accessWideners.validated"].status, "skipped");
  assert.equal(tasks["accessTransformers.validated"].status, "skipped");
  // loom.cache.found is independent — its status is missing or ok, not skipped.
  assert.notEqual(tasks["loom.cache.found"].status, "skipped");
  assert.equal(result.summary.status, "ok");
});

test("validate-project tasks A3: minecraft.artifact.resolved error causes validators skipped, loom independent", async () => {
  const root = await makeWorkspace("validate-project-tasks-a3-");
  await writeBareGradleWorkspace(root);
  const mixinPath = join(root, "demo.mixins.json");
  await writeFile(mixinPath, JSON.stringify({ package: "demo.mixin", mixins: ["DemoMixin"] }), "utf8");

  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 1, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [mixinPath],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    resolveArtifact: async () => {
      throw new Error("simulated artifact resolution failure");
    }
  });

  const result = (await service.execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;

  assert.ok(result.tasks);
  const tasks = result.tasks!;
  assert.equal(tasks["minecraft.artifact.resolved"].status, "error");
  assert.equal(tasks["mixins.validated"].status, "skipped");
  assert.equal(tasks["accessWideners.validated"].status, "skipped");
  assert.equal(tasks["accessTransformers.validated"].status, "skipped");
  assert.notEqual(tasks["loom.cache.found"].status, "skipped");
});

test("validate-project tasks A4: discovery 0 paths sets corresponding entry to missing", async () => {
  const root = await makeWorkspace("validate-project-tasks-a4-");
  await writeBareGradleWorkspace(root);

  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 0, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    resolveArtifact: async () => ({ artifactId: "minecraft-1.21.10", mappingApplied: "obfuscated", warnings: [] })
  });

  const result = (await service.execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;

  const tasks = result.tasks!;
  assert.equal(tasks["mixins.validated"].status, "missing");
  assert.equal(tasks["accessWideners.validated"].status, "missing");
  assert.equal(tasks["accessTransformers.validated"].status, "missing");
});

test("validate-project tasks A5: VALIDATE_PROJECT_TASKS_OFF=1 omits the tasks field", async () => {
  // The flag is read at module load time. Spawn a child Node process to evaluate it.
  const root = await makeWorkspace("validate-project-tasks-a5-");
  await writeBareGradleWorkspace(root);

  const { spawnSync } = await import("node:child_process");
  const script = `
    import { ValidateProjectService } from "./src/entry-tools/validate-project-service.ts";
    const service = new ValidateProjectService({
      validateMixin: async () => ({ summary: { valid: 0, partial: 0, invalid: 0 }, warnings: [] }),
      validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
      discoverMixins: async () => [],
      discoverAccessWideners: async () => [],
      discoverAccessTransformers: async () => [],
      resolveArtifact: async () => ({ artifactId: "minecraft-1.21.10", mappingApplied: "obfuscated", warnings: [] })
    });
    const result = await service.execute({
      task: "project-summary",
      detail: "full",
      include: ["workspace"],
      version: "1.21.10",
      subject: { kind: "workspace", projectPath: ${JSON.stringify(root)} }
    });
    console.log(JSON.stringify({ hasTasks: "tasks" in result }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, VALIDATE_PROJECT_TASKS_OFF: "1" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.hasTasks, false);
});

test("validate-project tasks A6: detail=summary or include without workspace strips evidence/buildScripts/counts", async () => {
  const root = await makeWorkspace("validate-project-tasks-a6-");
  await writeBareGradleWorkspace(root);
  const mixinPath = join(root, "demo.mixins.json");
  await writeFile(mixinPath, JSON.stringify({ package: "demo.mixin", mixins: ["DemoMixin"] }), "utf8");

  const baseDeps = {
    validateMixin: async () => ({ summary: { valid: 1, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [mixinPath],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    resolveArtifact: async () => ({ artifactId: "minecraft-1.21.10", mappingApplied: "obfuscated" as const, warnings: [] })
  };

  const summary = (await new ValidateProjectService(baseDeps).execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;
  const summaryTasks = summary.tasks!;
  assert.equal(summaryTasks["workspace.detected"].evidence, undefined);
  assert.equal(summaryTasks["gradle.readable"].buildScripts, undefined);
  assert.equal(summaryTasks["mixins.validated"].counts, undefined);
  assert.equal(summaryTasks["minecraft.artifact.resolved"].artifactId, undefined);

  const full = (await new ValidateProjectService(baseDeps).execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;
  const fullTasks = full.tasks!;
  assert.ok(Array.isArray(fullTasks["workspace.detected"].evidence));
  assert.ok(Array.isArray(fullTasks["gradle.readable"].buildScripts));
  assert.ok(fullTasks["mixins.validated"].counts);
  assert.ok(fullTasks["minecraft.artifact.resolved"].artifactId);
});

test("validate-project tasks A7: callers ignoring tasks see byte-identical other fields", async () => {
  const root = await makeWorkspace("validate-project-tasks-a7-");
  await writeBareGradleWorkspace(root);

  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 0, partial: 0, invalid: 0 }, warnings: ["mixin warn"] }),
    validateAccessWidener: async () => ({ valid: true, header: "", namespace: "named", issues: [], warnings: [] }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    resolveArtifact: async () => ({ artifactId: "minecraft-1.21.10", mappingApplied: "obfuscated", warnings: [] })
  });

  const result = (await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: root }
  })) as Result;

  assert.ok("tasks" in result);
  const stripped = { ...result };
  delete stripped.tasks;
  assert.equal(stripped.task, "project-summary");
  assert.equal(stripped.summary.status, "ok");
  assert.deepEqual(Object.keys(stripped.summary).sort(), ["counts", "headline", "status", "subject"]);
  assert.equal(stripped.summary.counts.valid, 0);
  assert.equal(stripped.summary.counts.invalid, 0);
});
