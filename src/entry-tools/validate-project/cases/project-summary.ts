import { readFile } from "node:fs/promises";
import { buildEntryToolResult, createSummarySubject, type DetailLevel } from "../../response-contract.js";
import { ERROR_CODES, createError } from "../../../errors.js";
import { buildSuggestedCall } from "../../../build-suggested-call.js";
import type { ValidateProjectInput } from "../../validate-project-service.js";
import { buildEarlyTasksForBlocked, buildFullTaskStatusReport, type ValidateProjectDeps } from "../internal.js";

export async function handleProjectSummary(
  deps: ValidateProjectDeps,
  input: ValidateProjectInput,
  detail: DetailLevel,
  include: string[]
) {
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
            subject: input.subject
          }
        }
      ],
      notes: [
        "Pass version explicitly, or retry with preferProjectVersion=true when gradle.properties declares the Minecraft version."
      ]
    },
    blocks: {
      workspace: {
        projectPath: input.subject.projectPath
      }
    }
  });
  const tasks = await buildEarlyTasksForBlocked(input.subject.projectPath, detail, include);
  return {
    ...baseResult,
    ...(tasks ? { tasks } : {}),
    warnings: []
  };
}

const projectPath = input.subject.projectPath;
const detectedProjectVersion = input.preferProjectVersion
  ? await deps.detectProjectMinecraftVersion?.(projectPath)
  : undefined;
const resolvedVersion = detectedProjectVersion ?? input.version;
const discover = input.subject.discover ?? ["mixins", "access-wideners"];
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
  const tasks = await buildEarlyTasksForBlocked(projectPath, detail, include, {
    mixinDiscoveryCount: mixinConfigs.length,
    awDiscoveryCount: accessWideners.length,
    atDiscoveryCount: accessTransformers.length
  });
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
  const tasks = await buildEarlyTasksForBlocked(projectPath, detail, include);
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
for (const configPath of mixinConfigs) {
  try {
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
      preferProjectVersion: false,
      preferProjectMapping: input.preferProjectMapping,
      sourceRoots: input.sourceRoots,
      minSeverity: input.minSeverity,
      hideUncertain: input.hideUncertain,
      explain: input.explain,
      warningMode: input.warningMode,
      warningCategoryFilter: input.warningCategoryFilter,
      treatInfoAsWarning: input.treatInfoAsWarning,
      includeIssues: input.includeIssues
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
for (const awPath of accessWideners) {
  try {
    const output = await deps.validateAccessWidener({
      content: await readFile(awPath, "utf8"),
      version: validationVersion,
      mapping: input.mapping,
      sourcePriority: input.sourcePriority,
      projectPath,
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
for (const atPath of accessTransformers) {
  try {
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
const tasks = await buildFullTaskStatusReport(deps, {
  projectPath,
  detail,
  include,
  resolvedVersion: validationVersion,
  mapping: input.mapping,
  sourcePriority: input.sourcePriority,
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
  atDurationMs
});
return {
  ...baseResult,
  ...(tasks ? { tasks } : {}),
  warnings
};
}
