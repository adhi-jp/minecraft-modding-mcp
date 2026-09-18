import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ERROR_CODES } from "../../../src/errors.ts";
import { buildValidateProjectSuggestedParams } from "../../../src/tool-guidance.ts";
import {
  discoverWorkspaceAccessTransformers,
  ValidateProjectService,
  validateProjectSchema
} from "../../../src/entry-tools/validate-project-service.ts";

test("validate-project workspace discovery uses async glob paths", async () => {
  const validateProjectSource = await readFile("src/entry-tools/validate-project-service.ts", "utf8");

  assert.doesNotMatch(validateProjectSource, /fastGlob\.sync\(/);
  assert.match(validateProjectSource, /mapWithConcurrencyLimit/);
});

test("ValidateProjectService forwards the default reportMode (summary-first) to validateMixin", async () => {
  let seenReportMode: string | undefined = "UNSET";
  const service = new ValidateProjectService({
    validateMixin: async (input: { reportMode?: string }) => {
      seenReportMode = input.reportMode;
      return { summary: { total: 1, valid: 1, partial: 0, invalid: 0 }, results: [], warnings: [] } as never;
    },
    validateAccessWidener: async () => { throw new Error("not used"); },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  // execute() does not run the Zod schema, so parse first to apply the default.
  const parsed = validateProjectSchema.parse({
    task: "mixin",
    version: "1.21.10",
    subject: { kind: "mixin", input: { mode: "inline", source: "class M {}" } }
  });
  await service.execute(parsed);

  assert.equal(seenReportMode, "summary-first");
});

test("ValidateProjectService validates direct access widener inline input", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "access-widener",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "access-widener",
      input: {
        mode: "inline",
        content: "accessWidener v2 named\naccessible class net/minecraft/world/item/Item"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
});

test("ValidateProjectService validates direct access transformer inline input", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    validateAccessTransformer: async () => ({
      valid: true,
      entries: [],
      summary: { total: 1, valid: 1, invalid: 0 },
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => []
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "summary",
    version: "1.21.10",
    atNamespace: "mojang",
    subject: {
      kind: "access-transformer",
      input: {
        mode: "inline",
        content: "public net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
});

test("ValidateProjectService access-transformer issues block only includes invalid entries", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    validateAccessTransformer: async () => ({
      valid: false,
      entries: [
        {
          target: "net.minecraft.server.MinecraftServer",
          targetKind: "class",
          valid: true
        },
        {
          target: "net.minecraft.server.MinecraftServer#missingField",
          targetKind: "field",
          valid: false,
          issue: "Field missingField not found."
        }
      ],
      summary: { total: 2, valid: 1, invalid: 1 },
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => []
  });

  const result = await service.execute({
    task: "access-transformer",
    detail: "full",
    version: "1.21.10",
    subject: {
      kind: "access-transformer",
      input: {
        mode: "inline",
        content: "public net.minecraft.server.MinecraftServer"
      }
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(Array.isArray(result.issues), true);
  assert.equal((result.issues as Array<Record<string, unknown>>).length, 1);
  assert.equal((result.issues as Array<Record<string, unknown>>)[0]?.valid, false);
});

test("ValidateProjectService project-summary blocked recovery suggests preferProjectVersion without a hardcoded version", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const subject = {
    kind: "workspace" as const,
    projectPath: "/workspace/demo-mod"
  };
  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    preferProjectVersion: false,
    subject
  });

  assert.equal(result.summary.status, "blocked");
  // The recovery must make progress instead of repeating the same blocked call:
  // it adds preferProjectVersion=true (no hardcoded/placeholder version).
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "validate-project",
      params: {
        task: "project-summary",
        subject,
        preferProjectVersion: true
      }
    }
  ]);
});

test("ValidateProjectService project-summary continues when one discovered mixin config fails validation", async () => {
  const service = new ValidateProjectService({
    validateMixin: async (input) => {
      const configPath = input.input.mode === "config" ? input.input.configPaths[0] : "";
      if (configPath?.endsWith("empty.mixins.json")) {
        throw new Error("Mixin config(s) contain no mixin class entries.");
      }
      return {
        summary: {
          valid: 1,
          partial: 0,
          invalid: 0
        },
        warnings: ["validated mixin config"]
      };
    },
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    discoverMixins: async () => [
      "/workspace/demo-mod/src/main/resources/empty.mixins.json",
      "/workspace/demo-mod/src/main/resources/demo.mixins.json"
    ],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod"
    }
  });

  assert.equal(result.summary.status, "invalid");
  assert.equal(result.project?.summary?.valid, 1);
  assert.equal(result.project?.summary?.invalid, 1);
  assert.ok(result.warnings?.some((warning) => warning.includes("empty.mixins.json")));
  assert.ok(result.warnings?.some((warning) => warning.includes("validated mixin config")));
});

test("ValidateProjectService project-summary keeps empty mixin configs as warnings", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => ({
      summary: {
        valid: 0,
        partial: 0,
        invalid: 0
      },
      warnings: ["Mixin config \"/workspace/demo-mod/src/main/resources/empty.mixins.json\" contains no mixin class entries."]
    }),
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    discoverMixins: async () => ["/workspace/demo-mod/src/main/resources/empty.mixins.json"],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod"
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 0);
  assert.equal(result.project?.summary?.invalid, 0);
  assert.ok(result.warnings?.some((warning) => warning.includes("contains no mixin class entries")));
});

test("ValidateProjectService project-summary applies preferProjectVersion to discovered access wideners", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-prefer-version-"));
  const awPath = join(root, "src", "main", "resources", "example.accesswidener");
  const mixinConfigPath = join(root, "src", "client", "resources", "example.client.mixins.json");
  await mkdir(join(root, "src", "main", "resources"), { recursive: true });
  await mkdir(join(root, "src", "client", "resources"), { recursive: true });
  await writeFile(
    awPath,
    "accessWidener v2 named\naccessible class net/minecraft/client/Minecraft\n",
    "utf8"
  );
  await writeFile(
    mixinConfigPath,
    JSON.stringify({ package: "com.example.mixin.client", client: ["ExampleClientMixin"] }, null, 2),
    "utf8"
  );

  let seenMixinProjectPath: string | undefined;
  let seenVersion: string | undefined;
  const service = new ValidateProjectService({
    validateMixin: async (input) => {
      seenMixinProjectPath = input.projectPath;
      return {
        summary: {
          valid: 1,
          partial: 0,
          invalid: 0
        },
        warnings: []
      };
    },
    validateAccessWidener: async (input) => {
      seenVersion = input.version;
      return {
        valid: true,
        header: "accessWidener v2 named",
        namespace: "named",
        issues: [],
        warnings: []
      };
    },
    discoverMixins: async () => [mixinConfigPath],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async (projectPath) => {
      assert.equal(projectPath, root);
      return "26.1";
    }
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    preferProjectVersion: true,
    preferProjectMapping: true,
    subject: {
      kind: "workspace",
      projectPath: root
    }
  });

  assert.equal(seenMixinProjectPath, root);
  assert.equal(seenVersion, "26.1");
  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 2);
  assert.equal(result.project?.summary?.invalid, 0);
});

test("ValidateProjectService project-summary forwards runtime-aware access widener inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-aw-runtime-aware-"));
  const awPath = join(root, "src", "main", "resources", "example.accesswidener");
  await mkdir(join(root, "src", "main", "resources"), { recursive: true });
  await writeFile(
    awPath,
    "accessWidener v2 named\naccessible class net/minecraft/client/Minecraft\n",
    "utf8"
  );

  let seenProjectPath: string | undefined;
  let seenScope: string | undefined;
  let seenPreferProjectVersion: boolean | undefined;
  const service = new ValidateProjectService({
    validateMixin: async () => ({
      summary: {
        valid: 0,
        partial: 0,
        invalid: 0
      },
      warnings: []
    }),
    validateAccessWidener: async (input) => {
      seenProjectPath = (input as { projectPath?: string }).projectPath;
      seenScope = (input as { scope?: string }).scope;
      seenPreferProjectVersion = (input as { preferProjectVersion?: boolean }).preferProjectVersion;
      return {
        valid: true,
        header: "accessWidener v2 named",
        namespace: "named",
        issues: [],
        warnings: []
      };
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async () => "26.1"
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    scope: "loader",
    preferProjectVersion: true,
    subject: {
      kind: "workspace",
      projectPath: root
    }
  });

  assert.equal(seenProjectPath, root);
  assert.equal(seenScope, "loader");
  assert.equal(seenPreferProjectVersion, true);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
});

test("ValidateProjectService project-summary discovers and forwards runtime-aware access transformer inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-at-runtime-aware-"));
  const atPath = join(root, "src", "main", "resources", "META-INF", "accesstransformer.cfg");
  await mkdir(join(root, "src", "main", "resources", "META-INF"), { recursive: true });
  await writeFile(
    atPath,
    "public net.minecraft.server.MinecraftServer\n",
    "utf8"
  );

  let seenProjectPath: string | undefined;
  let seenScope: string | undefined;
  let seenAtNamespace: string | undefined;
  const service = new ValidateProjectService({
    validateMixin: async () => ({
      summary: {
        valid: 0,
        partial: 0,
        invalid: 0
      },
      warnings: []
    }),
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    validateAccessTransformer: async (input) => {
      seenProjectPath = input.projectPath;
      seenScope = input.scope;
      seenAtNamespace = input.atNamespace;
      return {
        valid: true,
        entries: [],
        summary: { total: 1, valid: 1, invalid: 0 },
        warnings: []
      };
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [atPath]
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    scope: "loader",
    subject: {
      kind: "workspace",
      projectPath: root,
      discover: ["access-transformers"]
    }
  });

  assert.equal(seenProjectPath, root);
  assert.equal(seenScope, "loader");
  assert.equal(seenAtNamespace, undefined);
  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 1);
});

test("ValidateProjectService project-summary does not discover access transformers unless requested", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-at-default-discover-"));
  let accessTransformerDiscoveryCalls = 0;

  const service = new ValidateProjectService({
    validateMixin: async () => ({
      summary: {
        valid: 0,
        partial: 0,
        invalid: 0
      },
      warnings: []
    }),
    validateAccessWidener: async () => ({
      valid: true,
      header: "accessWidener v2 named",
      namespace: "named",
      issues: [],
      warnings: []
    }),
    validateAccessTransformer: async () => ({
      valid: true,
      entries: [],
      summary: { total: 1, valid: 1, invalid: 0 },
      warnings: []
    }),
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => {
      accessTransformerDiscoveryCalls += 1;
      return [];
    }
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: {
      kind: "workspace",
      projectPath: root
    }
  });

  assert.equal(accessTransformerDiscoveryCalls, 0);
  assert.equal(result.summary.status, "ok");
});

test("discoverWorkspaceAccessTransformers keeps accessTransformers block matches scoped to the block", async () => {
  const root = await mkdtemp(join(tmpdir(), "discover-workspace-at-blocks-"));
  const buildFilePath = join(root, "build.gradle");
  await writeFile(
    buildFilePath,
    [
      "neoForge {",
      "  accessTransformers {",
      "    file('src/main/resources/META-INF/accesstransformer.cfg')",
      "  }",
      "}",
      "",
      "tasks.register('demo') {",
      "  file('should-not-be-picked.cfg')",
      "}"
    ].join("\n"),
    "utf8"
  );

  const result = await discoverWorkspaceAccessTransformers(root);

  assert.deepEqual(result, [join(root, "src", "main", "resources", "META-INF", "accesstransformer.cfg")]);
});

test("ValidateProjectService project-summary uses detected project version consistently across mixins and access wideners", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-consistent-version-"));
  const awPath = join(root, "src", "main", "resources", "example.accesswidener");
  const mixinConfigPath = join(root, "src", "client", "resources", "example.client.mixins.json");
  await mkdir(join(root, "src", "main", "resources"), { recursive: true });
  await mkdir(join(root, "src", "client", "resources"), { recursive: true });
  await writeFile(
    awPath,
    "accessWidener v2 named\naccessible class net/minecraft/client/Minecraft\n",
    "utf8"
  );
  await writeFile(
    mixinConfigPath,
    JSON.stringify({ package: "com.example.mixin.client", client: ["ExampleClientMixin"] }, null, 2),
    "utf8"
  );

  let seenMixinVersion: string | undefined;
  let seenAwVersion: string | undefined;
  const service = new ValidateProjectService({
    validateMixin: async (input) => {
      seenMixinVersion = input.version;
      return {
        summary: {
          valid: 1,
          partial: 0,
          invalid: 0
        },
        warnings: []
      };
    },
    validateAccessWidener: async (input) => {
      seenAwVersion = input.version;
      return {
        valid: true,
        header: "accessWidener v2 named",
        namespace: "named",
        issues: [],
        warnings: []
      };
    },
    discoverMixins: async () => [mixinConfigPath],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async () => "26.1"
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    preferProjectVersion: true,
    subject: {
      kind: "workspace",
      projectPath: root
    }
  });

  assert.equal(seenMixinVersion, "26.1");
  assert.equal(seenAwVersion, "26.1");
  assert.equal(result.summary.status, "ok");
  assert.equal(result.project?.summary?.valid, 2);
});

test("ValidateProjectService project-summary blocks discovered validators when project version cannot be resolved", async () => {
  const root = await mkdtemp(join(tmpdir(), "validate-project-missing-version-"));
  const awPath = join(root, "src", "main", "resources", "example.accesswidener");
  const mixinConfigPath = join(root, "src", "client", "resources", "example.client.mixins.json");
  await mkdir(join(root, "src", "main", "resources"), { recursive: true });
  await mkdir(join(root, "src", "client", "resources"), { recursive: true });
  await writeFile(
    awPath,
    "accessWidener v2 named\naccessible class net/minecraft/client/Minecraft\n",
    "utf8"
  );
  await writeFile(
    mixinConfigPath,
    JSON.stringify({ package: "com.example.mixin.client", client: ["ExampleClientMixin"] }, null, 2),
    "utf8"
  );

  const service = new ValidateProjectService({
    validateMixin: async () => {
      assert.fail("mixin validation should be skipped when no version can be resolved");
    },
    validateAccessWidener: async () => {
      assert.fail("access widener validation should be skipped when no version can be resolved");
    },
    discoverMixins: async () => [mixinConfigPath],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async () => undefined
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    preferProjectVersion: true,
    subject: {
      kind: "workspace",
      projectPath: root
    }
  });

  assert.equal(result.summary.status, "blocked");
  assert.match(result.summary.headline, /Could not resolve Minecraft version/i);
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "validate-project",
      params: {
        task: "project-summary",
        subject: {
          kind: "workspace",
          projectPath: root
        },
        version: "<minecraft-version>"
      }
    }
  ]);
  assert.ok(result.warnings?.some((warning) => warning.includes("gradle.properties")));
});

test("ValidateProjectService version-required tasks throw ERR_INVALID_INPUT with a suggestedCall when no version is resolvable", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("should not be called");
    },
    validateAccessWidener: async () => {
      throw new Error("should not be called");
    },
    validateAccessTransformer: async () => {
      throw new Error("should not be called");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => []
  });

  const assertProblem = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null || !("code" in error)) {
      return false;
    }
    if ((error as { code: string }).code !== ERROR_CODES.INVALID_INPUT) {
      return false;
    }
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    return (
      details.failedStage === "input-validation" &&
      typeof details.nextAction === "string" &&
      typeof details.suggestedCall === "object" &&
      details.suggestedCall !== null
    );
  };

  const cases: Array<{
    label: string;
    task: "mixin" | "access-widener" | "access-transformer";
    preferProjectVersion?: boolean;
    subject: Record<string, unknown>;
  }> = [
    {
      label: "mixin",
      task: "mixin",
      subject: { kind: "mixin", input: { mode: "inline", source: "public class Example {}" } }
    },
    {
      label: "mixin + preferProjectVersion (no explicit version)",
      task: "mixin",
      preferProjectVersion: true,
      subject: { kind: "mixin", input: { mode: "inline", source: "public class Example {}" } }
    },
    {
      label: "access-widener",
      task: "access-widener",
      subject: { kind: "access-widener", input: { mode: "inline", content: "accessWidener v2 named" } }
    },
    {
      label: "access-transformer",
      task: "access-transformer",
      subject: {
        kind: "access-transformer",
        input: { mode: "inline", content: "public net.minecraft.server.MinecraftServer" }
      }
    }
  ];

  for (const testCase of cases) {
    await assert.rejects(
      () =>
        service.execute({
          task: testCase.task,
          detail: "summary",
          ...(testCase.preferProjectVersion ? { preferProjectVersion: true } : {}),
          subject: testCase.subject
        } as Parameters<typeof service.execute>[0]),
      assertProblem,
      `expected ERR_INVALID_INPUT with suggestedCall for task=${testCase.label}`
    );
  }
});

// `suggestedCall` is a payload the caller may replay verbatim. This branch fires
// precisely because no version is knowable here, and it used to fill the hole
// with a hardcoded "1.21.10": a payload that RUNS and validates the mixin
// against a Minecraft version the project does not use. A wrong answer that
// executes is worse than no suggestion.
//
// The repair splits the two roles rather than dropping the recovery payload:
// `suggestedCall` becomes a real, argument-free next step (list-versions, the
// same recovery the sibling "version required but none resolved" site in
// src/source/class-source.ts already uses), and the task="mixin" retry shape
// moves to an `exampleCalls` template with a placeholder the caller must
// visibly replace.
test("task=\"mixin\" without a version suggests list-versions and a placeholder template, never a fabricated version", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("should not be called");
    },
    validateAccessWidener: async () => {
      throw new Error("should not be called");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const caught = await service
    .execute({
      task: "mixin",
      detail: "summary",
      subject: { kind: "mixin", input: { mode: "inline", source: "public class Example {}" } }
    } as Parameters<typeof service.execute>[0])
    .then(
      () => undefined,
      (error: unknown) => error
    );

  assert.equal((caught as { code?: string } | undefined)?.code, ERROR_CODES.INVALID_INPUT);
  const details = (caught as { details?: Record<string, unknown> }).details ?? {};

  // No fabricated concrete version may survive ANYWHERE in the recovery payload
  // -- not in the suggestedCall, not in a template, not in the prose hint.
  assert.equal(
    JSON.stringify(details).includes("1.21.10"),
    false,
    `no invented Minecraft version may appear in the recovery payload; got ${JSON.stringify(details)}`
  );

  const suggested = details.suggestedCall as
    | { tool?: string; params?: Record<string, unknown> }
    | undefined;
  assert.ok(suggested, "the caller still needs a re-executable next step");
  assert.equal(
    suggested.tool,
    "list-versions",
    "the suggestedCall must be a step the caller can run with what they already have"
  );
  assert.deepEqual(suggested.params, {}, "list-versions needs no arguments");

  const examples = details.exampleCalls as
    | Array<{ tool: string; params: Record<string, unknown> }>
    | undefined;
  const template = examples?.find((example) => example.tool === "validate-project");
  assert.ok(
    template,
    `the caller still needs the retry shape as a template; got ${JSON.stringify(examples)}`
  );
  assert.equal(template.params.task, "mixin");
  assert.equal(
    template.params.version,
    "<your-mc-version>",
    "the template must make the substitution the caller has to perform obvious"
  );
});

// project-summary version default: an omitted `version` is inferred from the
// project unless the caller passes preferProjectVersion=false explicitly.

async function makeDiscoveredWorkspaceFiles(prefix: string): Promise<{
  root: string;
  awPath: string;
  mixinConfigPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const resources = join(root, "src", "main", "resources");
  await mkdir(resources, { recursive: true });
  const awPath = join(resources, "example.accesswidener");
  const mixinConfigPath = join(resources, "example.mixins.json");
  await writeFile(awPath, "accessWidener v2 named\naccessible class net/minecraft/client/Minecraft\n", "utf8");
  await writeFile(
    mixinConfigPath,
    JSON.stringify({ package: "com.example.mixin", mixins: ["ExampleMixin"] }),
    "utf8"
  );
  return { root, awPath, mixinConfigPath };
}

test("ValidateProjectService project-summary infers an omitted version from the project when preferProjectVersion is omitted", async () => {
  const { root, awPath, mixinConfigPath } = await makeDiscoveredWorkspaceFiles("validate-project-infer-version-");
  const detectedFor: string[] = [];
  let seenMixinVersion: unknown;
  let seenAwVersion: string | undefined;
  const service = new ValidateProjectService({
    validateMixin: async (input) => {
      seenMixinVersion = input.version;
      return { summary: { valid: 1, partial: 0, invalid: 0 }, warnings: [] };
    },
    validateAccessWidener: async (input) => {
      seenAwVersion = input.version;
      return { valid: true, header: "accessWidener v2 named", namespace: "named", issues: [], warnings: [] };
    },
    discoverMixins: async () => [mixinConfigPath],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async (projectPath) => {
      detectedFor.push(projectPath);
      return "1.21.10";
    }
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    subject: { kind: "workspace", projectPath: root }
  });

  assert.deepEqual(detectedFor, [root], "the project version must be detected exactly once");
  assert.equal(result.summary.status, "ok");
  assert.equal(seenMixinVersion, "1.21.10");
  assert.equal(seenAwVersion, "1.21.10");
  assert.equal(result.summary.subject?.version, "1.21.10");
  assert.ok(
    result.warnings?.some((warning) => warning.startsWith("version was inferred from the workspace: 1.21.10")),
    `expected an inference warning; got ${JSON.stringify(result.warnings)}`
  );
});

test("ValidateProjectService project-summary treats an inferred version as a project-version resolution for sub-validators and the artifact probe", async () => {
  const { root, awPath } = await makeDiscoveredWorkspaceFiles("validate-project-infer-provenance-");
  await writeFile(join(root, "gradle.properties"), "minecraft_version=1.21.10\n", "utf8");
  await writeFile(join(root, "build.gradle"), "// test workspace\n", "utf8");
  const probeInputs: Array<{ value: string; preferProjectVersion?: boolean }> = [];
  let seenAwPreferProjectVersion: boolean | undefined;
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async (input) => {
      seenAwPreferProjectVersion = input.preferProjectVersion;
      return { valid: true, header: "accessWidener v2 named", namespace: "named", issues: [], warnings: [] };
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async () => "1.21.10",
    probeMinecraftArtifact: async (input) => {
      probeInputs.push({ value: input.target.value, preferProjectVersion: input.preferProjectVersion });
      return { artifactId: "probe-minecraft-1.21.10", mappingApplied: "obfuscated" as const };
    }
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "full",
    include: ["workspace"],
    subject: { kind: "workspace", projectPath: root }
  });

  assert.deepEqual(probeInputs, [{ value: "1.21.10", preferProjectVersion: true }]);
  assert.equal(seenAwPreferProjectVersion, true);
  assert.equal(result.tasks?.["minecraft.artifact.resolved"]?.status, "ok");
});

test("ValidateProjectService project-summary with preferProjectVersion=false and no version stays blocked without detecting the project version", async () => {
  let detectorCalls = 0;
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    detectProjectMinecraftVersion: async () => {
      detectorCalls += 1;
      return "1.21.10";
    }
  });

  const subject = { kind: "workspace" as const, projectPath: "/workspace/demo-mod" };
  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    preferProjectVersion: false,
    subject
  });

  assert.equal(detectorCalls, 0, "an explicit preferProjectVersion=false must suppress version inference");
  assert.equal(result.summary.status, "blocked");
  assert.equal(result.summary.headline, "project-summary requires version or preferProjectVersion=true.");
  assert.ok(
    result.summary.notes?.some((note) => note.includes("preferProjectVersion=false")),
    `the note must say inference was suppressed; got ${JSON.stringify(result.summary.notes)}`
  );
});

test("ValidateProjectService project-summary without a version or flag blocks with an explicit-version recovery when inference fails", async () => {
  const { root, awPath, mixinConfigPath } = await makeDiscoveredWorkspaceFiles("validate-project-infer-failed-");
  let detectorCalls = 0;
  const service = new ValidateProjectService({
    validateMixin: async () => {
      assert.fail("mixin validation must not run without a version");
    },
    validateAccessWidener: async () => {
      assert.fail("access widener validation must not run without a version");
    },
    discoverMixins: async () => [mixinConfigPath],
    discoverAccessWideners: async () => [awPath],
    detectProjectMinecraftVersion: async () => {
      detectorCalls += 1;
      return undefined;
    }
  });

  const subject = { kind: "workspace" as const, projectPath: root };
  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    subject
  });

  assert.equal(detectorCalls, 1);
  assert.equal(result.summary.status, "blocked");
  assert.match(result.summary.headline, /Could not resolve Minecraft version/i);
  // Replaying the failing shape (no version) would infer, fail, and block again,
  // so the recovery must ask for an explicit version instead.
  assert.deepEqual(result.summary.nextActions, [
    {
      tool: "validate-project",
      params: {
        task: "project-summary",
        subject,
        version: "<minecraft-version>"
      }
    }
  ]);
  assert.ok(
    result.summary.notes?.some((note) => note.includes("<minecraft-version>")),
    `the note must explain the version placeholder; got ${JSON.stringify(result.summary.notes)}`
  );
});

test("ValidateProjectService project-summary says nothing was validated when discovery finds no files", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: "/workspace/demo-mod" }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(
    result.summary.headline,
    "Nothing to validate: no mixin configs or access wideners were found."
  );
  assert.ok(
    result.warnings?.some((warning) => warning.startsWith("Nothing was validated:")),
    `a status-only reader needs the warning; got ${JSON.stringify(result.warnings)}`
  );
});

test("ValidateProjectService project-summary says nothing was validated when no version resolves and discovery finds no files", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => {
      throw new Error("not used");
    },
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    validateAccessTransformer: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => [],
    discoverAccessWideners: async () => [],
    discoverAccessTransformers: async () => [],
    detectProjectMinecraftVersion: async () => undefined
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/demo-mod",
      discover: ["mixins", "access-wideners", "access-transformers"]
    }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(
    result.summary.headline,
    "Nothing to validate: no mixin configs, access wideners, or access transformers were found."
  );
  assert.ok(
    result.warnings?.some((warning) => warning.startsWith("Nothing was validated:")),
    `a status-only reader needs the warning; got ${JSON.stringify(result.warnings)}`
  );
});

test("ValidateProjectService project-summary keeps the validated-count headline when discovery finds files", async () => {
  const service = new ValidateProjectService({
    validateMixin: async () => ({ summary: { valid: 1, partial: 0, invalid: 0 }, warnings: [] }),
    validateAccessWidener: async () => {
      throw new Error("not used");
    },
    discoverMixins: async () => ["/workspace/demo-mod/src/main/resources/demo.mixins.json"],
    discoverAccessWideners: async () => []
  });

  const result = await service.execute({
    task: "project-summary",
    detail: "summary",
    version: "1.21.10",
    subject: { kind: "workspace", projectPath: "/workspace/demo-mod" }
  });

  assert.equal(result.summary.status, "ok");
  assert.equal(
    result.summary.headline,
    "Validated 1 mixin config(s), 0 access widener(s), and 0 access transformer(s)."
  );
  assert.equal(
    result.warnings?.some((warning) => warning.startsWith("Nothing was validated:")),
    false
  );
});

test("validate-project recovery suggestions keep an explicit preferProjectVersion=false", () => {
  // Omitting preferProjectVersion now means "infer the version", so dropping an
  // explicit false as a default would silently undo the caller's opt-out.
  const params = buildValidateProjectSuggestedParams({
    task: "project-summary",
    subject: { kind: "workspace", projectPath: "/workspace/demo-mod" },
    preferProjectVersion: false
  });

  assert.equal(params.preferProjectVersion, false);
});
