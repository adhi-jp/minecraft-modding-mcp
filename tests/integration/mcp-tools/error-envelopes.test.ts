import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callTool } from "../../helpers/mcp-tools-harness.ts";
import { createJar } from "../../helpers/zip.ts";

test("applyErrorMetaExtensions surfaces stageBudgetExhausted / budgetMs / elapsedMs on ERR_STAGE_BUDGET_PRE_PARSE", async () => {
  const { applyErrorMetaExtensions } = await import("../../../src/index.ts");
  const { createError, ERROR_CODES } = await import("../../../src/errors.ts");

  const meta: { stageBudgetExhausted?: boolean; budgetMs?: number; elapsedMs?: number } = {};
  applyErrorMetaExtensions(
    meta as never,
    createError({
      code: ERROR_CODES.STAGE_BUDGET_PRE_PARSE,
      message: "Stage mapping-health exhausted budget before parse completed.",
      details: {
        failedStage: "mapping-health",
        stageBudgetExhausted: true,
        budgetMs: 1,
        elapsedMs: 12.5
      }
    })
  );
  assert.equal(meta.stageBudgetExhausted, true);
  assert.equal(meta.budgetMs, 1);
  assert.equal(meta.elapsedMs, 12.5);
});

test("applyErrorMetaExtensions does not touch meta for non-budget AppErrors or non-AppErrors", async () => {
  const { applyErrorMetaExtensions } = await import("../../../src/index.ts");
  const { createError, ERROR_CODES } = await import("../../../src/errors.ts");

  const meta1: Record<string, unknown> = {};
  applyErrorMetaExtensions(
    meta1 as never,
    createError({
      code: ERROR_CODES.INVALID_INPUT,
      message: "bad input",
      details: { stageBudgetExhausted: true, budgetMs: 99 }
    })
  );
  assert.deepEqual(meta1, {}, "non-budget AppErrors must not pass through budget meta");

  const meta2: Record<string, unknown> = {};
  applyErrorMetaExtensions(meta2 as never, new Error("plain"));
  assert.deepEqual(meta2, {}, "plain Error must not pass through budget meta");
});

test("validate-mixin invalid input returns problem details with a retryable suggestedCall", async () => {
  const result = await callTool("validate-mixin", {
    input: "@Mixin(Player.class) class ExampleMixin {}",
    version: "1.21.10",
    minSeverity: "all",
    hideUncertain: false,
    explain: false,
    preferProjectMapping: false,
    reportMode: "full",
    treatInfoAsWarning: true,
    includeIssues: true
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            input?: { mode?: string; source?: string };
            version?: string;
            reportMode?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
  assert.equal(result.structuredContent?.error?.fieldErrors?.[0]?.path, "input");
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("input.mode")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-mixin");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    input: {
      mode: "inline",
      source: "@Mixin(Player.class) class ExampleMixin {}"
    },
    version: "1.21.10",
    // reportMode="full" is now a non-default explicit value, so it survives the
    // recovery suggestedCall (default is "summary-first").
    reportMode: "full"
  });
});

test("validate-mixin invalid JSON-like input string preserves structured input in suggestedCall", async () => {
  const result = await callTool("validate-mixin", {
    input: "{\"mode\":\"path\",\"path\":\"/workspace/src/main/java/ExampleMixin.java\"}",
    version: "1.21.10"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            input?: { mode?: string; path?: string };
            version?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-mixin");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    input: {
      mode: "path",
      path: "/workspace/src/main/java/ExampleMixin.java"
    },
    version: "1.21.10"
  });
});

test("validate-mixin error envelope surfaces details.failedStage for caller recovery", async () => {
  const result = await callTool("validate-mixin", {
    input: { mode: "path", path: "/nonexistent/__validate_mixin_stage_test__/Missing.java" },
    version: "1.21.10"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
});

test("validate-mixin removed-namespace mapping=\"official\" carries failedStage=input-validation", async () => {
  const result = await callTool("validate-mixin", {
    input: { mode: "inline", source: "@Mixin(Player.class) class ExampleMixin {}" },
    version: "1.21.10",
    mapping: "official"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        failedStage?: string;
        suggestedCall?: { tool?: string; params?: { mapping?: string } };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.failedStage, "input-validation");
});

test("validate-mixin removed-namespace surfaces a validated obfuscated suggestedCall via the single gate", async () => {
  // Regression lock for the double-validation removal: index.ts no longer
  // pre-validates the suggestedCall, so the sole mapErrorToProblem gate must
  // still emit the obfuscated replacement with no leaked internal marker.
  const result = await callTool("validate-mixin", {
    input: { mode: "inline", source: "@Mixin(Player.class) class ExampleMixin {}" },
    version: "1.21.10",
    mapping: "official"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: Record<string, unknown> & {
        code?: string;
        suggestedCall?: { tool?: string; params?: Record<string, unknown> };
      };
    };
  };

  assert.equal(result.isError, true);
  const error = result.structuredContent?.error;
  assert.equal(error?.code, "ERR_INVALID_INPUT");
  assert.equal(error?.suggestedCall?.tool, "validate-mixin");
  assert.equal(
    error?.suggestedCall?.params?.mapping,
    "obfuscated",
    "the single validation gate must rewrite official -> obfuscated in the suggestedCall"
  );
  // The internal buildSuggestedCall marker must never leak into the envelope.
  assert.equal(
    "_suggestedCallPrimaryDropped" in (error ?? {}),
    false,
    "the _suggestedCallPrimaryDropped marker must not appear in the error envelope"
  );
});

test("validate-project invalid legacy workspace payload returns a structured suggestedCall", async () => {
  const result = await callTool("validate-project", {
    task: "project-summary",
    subject: "/workspace/architectury",
    detail: "summary",
    include: ["projectSummary", "detectedConfig", "validationSummary"],
    preferProjectMapping: true,
    preferProjectVersion: true,
    includeIssues: false,
    warningMode: "aggregated"
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            subject?: { kind?: string; projectPath?: string };
            include?: string[];
            preferProjectMapping?: boolean;
            preferProjectVersion?: boolean;
            includeIssues?: boolean;
            warningMode?: string;
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject"));
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "include.0"));
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("subject.kind=workspace")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "validate-project");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "project-summary",
    subject: {
      kind: "workspace",
      projectPath: "/workspace/architectury"
    },
    include: ["workspace"],
    preferProjectMapping: true,
    preferProjectVersion: true,
    includeIssues: false,
    warningMode: "aggregated"
  });
});

test("analyze-mod invalid legacy summary payload returns a structured suggestedCall", async () => {
  const result = await callTool("analyze-mod", {
    task: "summary",
    subject: "/workspace/example.jar",
    detail: "summary",
    include: ["metadata", "entrypoints", "mixins", "dependencies"]
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
        hints?: string[];
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            detail?: string;
            subject?: { kind?: string; jarPath?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "subject"));
  assert.ok(result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "include.0"));
  assert.ok(result.structuredContent?.error?.hints?.some((hint) => hint.includes("subject.kind=jar")));
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "analyze-mod");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "summary",
    detail: "standard",
    subject: {
      kind: "jar",
      jarPath: "/workspace/example.jar"
    }
  });
});

test("analyze-mod invalid legacy summary payload without detail still promotes metadata retries to standard detail", async () => {
  const result = await callTool("analyze-mod", {
    task: "summary",
    subject: "/workspace/example.jar",
    include: ["metadata", "entrypoints"]
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        suggestedCall?: {
          tool?: string;
          params?: {
            task?: string;
            detail?: string;
            subject?: { kind?: string; jarPath?: string };
          };
        };
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.equal(result.structuredContent?.error?.suggestedCall?.tool, "analyze-mod");
  assert.deepEqual(result.structuredContent?.error?.suggestedCall?.params, {
    task: "summary",
    detail: "standard",
    subject: {
      kind: "jar",
      jarPath: "/workspace/example.jar"
    }
  });
});

test("validate-project rejects top-level configPaths for direct access-widener validation", async () => {
  const result = await callTool("validate-project", {
    task: "access-widener",
    version: "1.21.10",
    configPaths: ["example.mixins.json"],
    subject: {
      kind: "access-widener",
      input: {
        mode: "inline",
        content: "accessWidener v2 named"
      }
    }
  }) as {
    isError?: boolean;
    structuredContent?: {
      error?: {
        code?: string;
        fieldErrors?: Array<{ path?: string }>;
      };
    };
  };

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, "ERR_INVALID_INPUT");
  assert.ok(
    result.structuredContent?.error?.fieldErrors?.some((entry) => entry.path === "configPaths")
  );
});

// The hop that made this classification drift, driven through the REAL entry
// point. On the wire `get-class-members` has no top-level `artifactId`; it has
// `target`, one arm of which is `{ kind: "artifact", artifactId }`.
// `normalizeSourceLookupTarget` in src/index.ts flattens that arm to a bare
// `artifactId` BEFORE the service runs, so by the time the no-binary-jar
// classifier sees the input, the only trace of the caller's chosen kind is
// whether `target` survived. Reading the flattened `artifactId` as "the caller
// named this artifact" therefore classified the request SYNTAX, not blame - and
// nothing covered the hop, so nothing caught it.
//
// Both calls below name the SAME artifact, so the artifact cannot be what moves
// the verdict; only the wire kind can. A `kind: "jar"` caller picked the exact
// jar and can pick another. A `kind: "artifact"` caller holds an opaque id that
// cannot tell them whether it carries a binary jar, and `resolve-artifact` will
// not even take an artifactId, so they cannot re-resolve it either.
test("get-class-members no-binary-jar issueOrigin follows the wire target kind, not the flattened artifactId", async () => {
  const root = await mkdtemp(join(tmpdir(), "members-issue-origin-wire-"));
  // A sources-only jar resolves fine and carries no binary companion, which is
  // exactly the artifact state under test.
  const sourcesJarPath = join(root, "wire-kind-lib-1.0.0-sources.jar");
  await createJar(sourcesJarPath, {
    "com/example/Demo.java": "package com.example;\npublic class Demo {}"
  });

  const resolveResult = await callTool("resolve-artifact", {
    target: { kind: "jar", value: sourcesJarPath },
    mapping: "obfuscated"
  }) as { structuredContent?: { result?: { artifactId?: string } } };
  const artifactId = resolveResult.structuredContent?.result?.artifactId;
  assert.ok(artifactId, "resolve-artifact must return an artifactId for a sources-only jar");

  type MembersErrorEnvelope = {
    isError?: boolean;
    structuredContent?: {
      error?: { code?: string; issueOrigin?: string; retryClass?: string; context?: { artifactId?: string } };
    };
  };

  const byArtifact = await callTool("get-class-members", {
    target: { kind: "artifact", artifactId },
    className: "com.example.Demo"
  }) as MembersErrorEnvelope;

  const byJar = await callTool("get-class-members", {
    target: { kind: "jar", value: sourcesJarPath },
    className: "com.example.Demo"
  }) as MembersErrorEnvelope;

  assert.equal(byArtifact.structuredContent?.error?.code, "ERR_CONTEXT_UNRESOLVED");
  assert.equal(byJar.structuredContent?.error?.code, "ERR_CONTEXT_UNRESOLVED");
  // Same artifact both times: the only variable is the wire target kind.
  assert.equal(
    byArtifact.structuredContent?.error?.context?.artifactId,
    artifactId,
    "the artifact-kind call must fail on the artifact under test"
  );
  assert.equal(
    byJar.structuredContent?.error?.context?.artifactId,
    artifactId,
    "the jar-kind call must fail on the very same artifact, so the artifact cannot explain the split"
  );

  assert.equal(
    byArtifact.structuredContent?.error?.issueOrigin,
    "tool_issue",
    "an opaque artifactId gives the caller nothing to change, so the miss is the tool's"
  );
  assert.equal(
    byJar.structuredContent?.error?.issueOrigin,
    "code_issue",
    "a caller who named the jar on the wire can name a different one"
  );
  // `retryClass` is code-keyed with no per-site seam, so it stays "input" on
  // both arms - deliberately disagreeing with issueOrigin on the artifact arm.
  assert.equal(byArtifact.structuredContent?.error?.retryClass, "input");
  assert.equal(byJar.structuredContent?.error?.retryClass, "input");
});
