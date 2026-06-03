import { readFile } from "node:fs/promises";
import { buildEntryToolResult, createSummarySubject, type DetailLevel } from "../../response-contract.js";
import { ERROR_CODES, createError } from "../../../errors.js";
import { buildSuggestedCall } from "../../../build-suggested-call.js";
import type { StageEmitter } from "../../../stage-emitter.js";
import type { ValidateProjectInput } from "../../validate-project-service.js";
import { buildEarlyTasksForBlocked, buildFullTaskStatusReport, type ValidateProjectDeps } from "../internal.js";

type ProjectSummaryOptions = {
  stageEmitter?: StageEmitter;
};

// Telemetry failures must not change validation outcomes; swallow rejections
// so a broken emitter does not abort the summary or count as a validation error.
async function safeEmit(
  emitter: StageEmitter | undefined,
  stage: string,
  payload?: Record<string, unknown>
): Promise<void> {
  if (!emitter) return;
  try {
    await emitter(stage, payload);
  } catch {
    // swallow telemetry failure
  }
}

export async function handleProjectSummary(
  deps: ValidateProjectDeps,
  input: ValidateProjectInput,
  detail: DetailLevel,
  include: string[],
  options: ProjectSummaryOptions = {}
) {
// Forwarded emitter for nested validators and probes; same swallow contract
// as safeEmit so a rejecting raw emitter cannot leak into their outcomes.
const wrappedEmitter: StageEmitter | undefined = options.stageEmitter
  ? (stage, meta) => safeEmit(options.stageEmitter, stage, meta)
  : undefined;
if (input.subject.kind !== "workspace") {
  throw createError({
    code: ERROR_CODES.INVALID_INPUT,
    message: "task=project-summary requires subject.kind=workspace."
  });
}
if (!input.version && !input.preferProjectVersion) {
  const baseResult = buildEntryToolResult({
    task: "project-summary",
    detail,
    include,
    summary: {
      status: "blocked",
      headline: "project-summary requires version or preferProjectVersion=true.",
      subject: createSummarySubject({
        task: "project-summary",
        kind: input.subject.kind,
        projectPath: input.subject.projectPath,
        discover: input.subject.discover
      }),
      nextActions: [
        {
          tool: "validate-project",
          params: {
            task: "project-summary",
            subject: input.subject,
            preferProjectVersion: true
          }
        }
      ],
      notes: [
        "Pass version explicitly, or retry with preferProjectVersion=true when gradle.properties declares the Minecraft version. The suggested retry sets preferProjectVersion=true for you."
      ]
    },
    blocks: {
      workspace: {
        projectPath: input.subject.projectPath
      }
    }
  });
  await safeEmit(options.stageEmitter,"validate-project:task-report", {
    projectPath: input.subject.projectPath,
    reason: "missing-version"
  });
  const tasks = await buildEarlyTasksForBlocked(
    input.subject.projectPath,
    detail,
    include,
    undefined,
    input.subject.gradleUserHome
  );
  return {
    ...baseResult,
    ...(tasks ? { tasks } : {}),
    warnings: []
  };
}

const projectPath = input.subject.projectPath;
const gradleUserHome = input.subject.gradleUserHome;
const discover = input.subject.discover ?? ["mixins", "access-wideners"];
await safeEmit(options.stageEmitter,"validate-project:workspace-discovery", {
  projectPath,
  discover
});
const detectedProjectVersion = input.preferProjectVersion
  ? await deps.detectProjectMinecraftVersion?.(projectPath)
  : undefined;
const resolvedVersion = detectedProjectVersion ?? input.version;
const [mixinConfigs, accessWideners, accessTransformers] = await Promise.all([
  discover.includes("mixins")
    ? deps.discoverMixins(projectPath, input.configPaths)
    : Promise.resolve([]),
  discover.includes("access-wideners")
    ? deps.discoverAccessWideners(projectPath)
    : Promise.resolve([]),
  discover.includes("access-transformers")
    ? deps.discoverAccessTransformers?.(projectPath) ?? Promise.resolve([])
    : Promise.resolve([])
]);

if (!resolvedVersion && (mixinConfigs.length > 0 || accessWideners.length > 0 || accessTransformers.length > 0)) {
  const baseResult = buildEntryToolResult({
    task: "project-summary",
    detail,
    include,
    summary: {
      status: "blocked",
      headline: "Could not resolve Minecraft version for discovered workspace validators.",
      subject: createSummarySubject({
        task: "project-summary",
        kind: input.subject.kind,
        projectPath,
        discover: input.subject.discover,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        scope: input.scope
      }),
      nextActions: [
        {
          tool: "validate-project",
          params: {
            task: "project-summary",
            subject: input.subject
          }
        }
      ],
      notes: [
        "Pass version explicitly, or make sure gradle.properties declares the Minecraft version before using preferProjectVersion=true."
      ]
    },
    blocks: {
      workspace: {
        projectPath
      }
    }
  });
  await safeEmit(options.stageEmitter,"validate-project:task-report", {
    projectPath,
    reason: "version-unresolved",
    mixinDiscoveryCount: mixinConfigs.length,
    awDiscoveryCount: accessWideners.length,
    atDiscoveryCount: accessTransformers.length
  });
  const tasks = await buildEarlyTasksForBlocked(projectPath, detail, include, {
    mixinDiscoveryCount: mixinConfigs.length,
    awDiscoveryCount: accessWideners.length,
    atDiscoveryCount: accessTransformers.length
  }, gradleUserHome);
  return {
    ...baseResult,
    ...(tasks ? { tasks } : {}),
    warnings: [
      "Could not resolve Minecraft version from gradle.properties for discovered workspace validators."
    ]
  };
}

if (!resolvedVersion) {
  const baseResult = buildEntryToolResult({
    task: "project-summary",
    detail,
    include,
    summary: {
      status: "ok",
      headline: `Validated ${mixinConfigs.length} mixin config(s), ${accessWideners.length} access widener(s), and ${accessTransformers.length} access transformer(s).`,
      subject: createSummarySubject({
        task: "project-summary",
        kind: input.subject.kind,
        projectPath,
        discover: input.subject.discover,
        mapping: input.mapping,
        sourcePriority: input.sourcePriority,
        scope: input.scope
      }),
      counts: {
        valid: 0,
        partial: 0,
        invalid: 0
      }
    },
    blocks: {
      workspace: {
        projectPath
      }
    }
  });
  await safeEmit(options.stageEmitter,"validate-project:task-report", {
    projectPath,
    reason: "version-not-required"
  });
  const tasks = await buildEarlyTasksForBlocked(projectPath, detail, include, undefined, gradleUserHome);
  return {
    ...baseResult,
    ...(tasks ? { tasks } : {}),
    warnings: []
  };
}

const validationVersion = resolvedVersion;
const warnings: string[] = [];
const mixinDurationStart = Date.now();
let validMixins = 0;
let partialMixins = 0;
let invalidMixins = 0;
let mixinCaughtErrors = 0;
await safeEmit(options.stageEmitter,"validate-project:mixin-validation", {
  targetTotal: mixinConfigs.length
});
for (const [mixinIndex, configPath] of mixinConfigs.entries()) {
  try {
    await safeEmit(options.stageEmitter,"validate-project:mixin-validation", {
      targetIndex: mixinIndex + 1,
      targetTotal: mixinConfigs.length,
      configPath
    });
    const mixinResult = await deps.validateMixin({
      input: {
        mode: "config",
        configPaths: [configPath]
      },
      version: validationVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope,
      projectPath,
      gradleUserHome,
      preferProjectVersion: false,
      preferProjectMapping: input.preferProjectMapping,
      sourceRoots: input.sourceRoots,
      minSeverity: input.minSeverity,
      hideUncertain: input.hideUncertain,
      explain: input.explain,
      warningMode: input.warningMode,
      warningCategoryFilter: input.warningCategoryFilter,
      treatInfoAsWarning: input.treatInfoAsWarning,
      includeIssues: input.includeIssues,
      reportMode: input.reportMode
    }, {
      stageEmitter: wrappedEmitter
    });
    const summary = mixinResult.summary as {
      valid?: number;
      partial?: number;
      invalid?: number;
    } | undefined;
    validMixins += summary?.valid ?? 0;
    partialMixins += summary?.partial ?? 0;
    invalidMixins += summary?.invalid ?? 0;
    if (Array.isArray(mixinResult.warnings)) {
      warnings.push(...mixinResult.warnings);
    }
  } catch (error) {
    invalidMixins += 1;
    mixinCaughtErrors += 1;
    if (error instanceof Error) {
      warnings.push(`${configPath}: ${error.message}`);
    }
  }
}
const mixinDurationMs = Date.now() - mixinDurationStart;

const awDurationStart = Date.now();
let validAw = 0;
let invalidAw = 0;
let awCaughtErrors = 0;
await safeEmit(options.stageEmitter,"validate-project:access-widener-validation", {
  targetTotal: accessWideners.length
});
for (const [awIndex, awPath] of accessWideners.entries()) {
  try {
    await safeEmit(options.stageEmitter,"validate-project:access-widener-validation", {
      targetIndex: awIndex + 1,
      targetTotal: accessWideners.length,
      filePath: awPath
    });
    const output = await deps.validateAccessWidener({
      content: await readFile(awPath, "utf8"),
      version: validationVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath,
      gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    if (output.valid) {
      validAw += 1;
    } else {
      invalidAw += 1;
    }
    if (Array.isArray(output.warnings)) {
      warnings.push(...output.warnings);
    }
  } catch (error) {
    invalidAw += 1;
    awCaughtErrors += 1;
    if (error instanceof Error) {
      warnings.push(error.message);
    }
  }
}
const awDurationMs = Date.now() - awDurationStart;

const atDurationStart = Date.now();
let validAt = 0;
let invalidAt = 0;
let atCaughtErrors = 0;
await safeEmit(options.stageEmitter,"validate-project:access-transformer-validation", {
  targetTotal: accessTransformers.length
});
for (const [atIndex, atPath] of accessTransformers.entries()) {
  try {
    await safeEmit(options.stageEmitter,"validate-project:access-transformer-validation", {
      targetIndex: atIndex + 1,
      targetTotal: accessTransformers.length,
      filePath: atPath
    });
    if (!deps.validateAccessTransformer) {
      throw createError({
        code: ERROR_CODES.CONTEXT_UNRESOLVED,
        message: "Access Transformer validation is not configured."
      });
    }
    const output = await deps.validateAccessTransformer({
      content: await readFile(atPath, "utf8"),
      version: validationVersion,
      atNamespace: input.atNamespace,
      sourcePriority: input.sourcePriority,
      projectPath,
      gradleUserHome,
      scope: input.scope,
      preferProjectVersion: input.preferProjectVersion
    });
    if (output.valid) {
      validAt += 1;
    } else {
      invalidAt += 1;
    }
    if (Array.isArray(output.warnings)) {
      warnings.push(...output.warnings);
    }
  } catch (error) {
    invalidAt += 1;
    atCaughtErrors += 1;
    if (error instanceof Error) {
      warnings.push(error.message);
    }
  }
}
const atDurationMs = Date.now() - atDurationStart;

const invalidCount = invalidMixins + invalidAw + invalidAt;
const partialCount = partialMixins;
const status = invalidCount > 0 ? "invalid" : partialCount > 0 ? "partial" : "ok";

const baseResult = buildEntryToolResult({
  task: "project-summary",
  detail,
  include,
  summary: {
    status,
    headline: `Validated ${mixinConfigs.length} mixin config(s), ${accessWideners.length} access widener(s), and ${accessTransformers.length} access transformer(s).`,
    subject: createSummarySubject({
      task: "project-summary",
      kind: input.subject.kind,
      projectPath,
      discover: input.subject.discover,
      version: resolvedVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      scope: input.scope
    }),
    counts: {
      valid: validMixins + validAw + validAt,
      partial: partialCount,
      invalid: invalidCount
    }
  },
  blocks: {
    project: {
      summary: {
        valid: validMixins + validAw + validAt,
        partial: partialCount,
        invalid: invalidCount
      }
    },
    workspace: {
      projectPath,
      mixinConfigs,
      accessWideners,
      accessTransformers
    }
  },
  alwaysBlocks: ["project"]
});
await safeEmit(options.stageEmitter,"validate-project:task-report", {
  projectPath,
  mixinDiscoveryCount: mixinConfigs.length,
  awDiscoveryCount: accessWideners.length,
  atDiscoveryCount: accessTransformers.length
});
const tasks = await buildFullTaskStatusReport(deps, {
  projectPath,
  detail,
  include,
  resolvedVersion: validationVersion,
  mapping: input.mapping,
  sourcePriority: input.sourcePriority,
  gradleUserHome,
  scope: input.scope,
  preferProjectVersion: input.preferProjectVersion,
  mixinDiscoveryCount: mixinConfigs.length,
  mixinCaughtErrors,
  mixinCounts: { ok: validMixins, partial: partialMixins, invalid: invalidMixins },
  mixinDurationMs,
  awDiscoveryCount: accessWideners.length,
  awCaughtErrors,
  awCounts: { ok: validAw, invalid: invalidAw },
  awDurationMs,
  atDiscoveryCount: accessTransformers.length,
  atCaughtErrors,
  atCounts: { ok: validAt, invalid: invalidAt },
  atDurationMs,
  stageEmitter: wrappedEmitter
});
return {
  ...baseResult,
  ...(tasks ? { tasks } : {}),
  warnings
};
}
