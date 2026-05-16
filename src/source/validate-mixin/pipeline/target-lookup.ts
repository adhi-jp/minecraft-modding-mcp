import { performance } from "node:perf_hooks";

import type { ParsedMixinTarget } from "../../../mixin-parser.js";
import type { FindMappingOutput as MappingFindMappingOutput } from "../../../mapping-service.js";
import type { TargetOutcome as MixinTargetOutcome } from "../../../mixin-validator.js";
import type { SourceService } from "../../../source-service.js";
import type { MappingSourcePriority, SourceMapping } from "../../../types.js";
import type { ValidateMixinSingleInput } from "../../validate-mixin.js";
import type { MutableMixinPipelineContext } from "../pipeline-context.js";

function findValidateMixinClassMapping(svc: SourceService, input: {
  version: string;
  className: string;
  sourceMapping: SourceMapping;
  targetMapping: SourceMapping;
  sourcePriority: MappingSourcePriority;
  projectPath?: string;
  gradleUserHome?: string;
  batchCaches?: ValidateMixinSingleInput["batchCaches"];
}): Promise<MappingFindMappingOutput> {
  const cache = input.batchCaches?.classMappings;
  if (!cache) {
    return svc.mappingService.findMapping({
      version: input.version,
      kind: "class",
      name: input.className,
      sourceMapping: input.sourceMapping,
      targetMapping: input.targetMapping,
      sourcePriority: input.sourcePriority,
      projectPath: input.projectPath,
      gradleUserHome: input.gradleUserHome
    });
  }

  const cacheKey = [
    input.version,
    input.className,
    input.sourceMapping,
    input.targetMapping,
    input.sourcePriority,
    input.projectPath ?? "",
    input.gradleUserHome ?? ""
  ].join("\0");
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = svc.mappingService.findMapping({
    version: input.version,
    kind: "class",
    name: input.className,
    sourceMapping: input.sourceMapping,
    targetMapping: input.targetMapping,
    sourcePriority: input.sourcePriority,
    projectPath: input.projectPath,
    gradleUserHome: input.gradleUserHome
  }).catch((error) => {
    cache.delete(cacheKey);
    throw error;
  });
  cache.set(cacheKey, pending);
  return pending;
}

export async function processSingleMixinTarget(
  svc: SourceService,
  ctx: MutableMixinPipelineContext,
  target: ParsedMixinTarget,
  targetIndex: number
): Promise<MixinTargetOutcome> {
  const totalTargets = ctx.parsed.targets.length;
  await ctx.stageEmitter("target-lookup", {
    targetIndex,
    targetTotal: totalTargets,
    targetClass: target.className,
    memberCount:
      ctx.parsed.injections.length + ctx.parsed.shadows.length + ctx.parsed.accessors.length
  });
  const targetStartedAt = performance.now();
  if (ctx.testHooks?.beforeTargetIter) {
    await ctx.testHooks.beforeTargetIter(targetIndex);
  }
  let resolvedClassName = target.className;
  if (!resolvedClassName.includes(".")) {
    const fqcn = ctx.parsed.imports.get(resolvedClassName);
    if (fqcn) {
      resolvedClassName = fqcn;
    }
  } else {
    const segments = resolvedClassName.split(".");
    const firstSegment = segments[0];
    if (firstSegment && /^[A-Z]/.test(firstSegment)) {
      const outerFqcn = ctx.parsed.imports.get(firstSegment);
      if (outerFqcn) {
        resolvedClassName = outerFqcn + "$" + segments.slice(1).join("$");
      }
    }
  }

  let obfuscatedName = resolvedClassName;

  if (ctx.requestedMapping !== ctx.signatureLookupMapping) {
    try {
      const mapped = await findValidateMixinClassMapping(svc, {
        version: ctx.version,
        className: resolvedClassName,
        sourceMapping: ctx.requestedMapping,
        targetMapping: ctx.signatureLookupMapping,
        sourcePriority: ctx.currentSourcePriority,
        projectPath: ctx.input.projectPath,
        gradleUserHome: ctx.input.gradleUserHome,
        batchCaches: ctx.input.batchCaches
      });
      if (mapped.resolved && mapped.resolvedSymbol) {
        obfuscatedName = mapped.resolvedSymbol.name;
        ctx.resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: true });
      } else {
        ctx.warnings.push(
          `Could not map class "${resolvedClassName}" from ${ctx.requestedMapping} to ${ctx.signatureLookupMapping}; using "${obfuscatedName}" for lookup.`
        );
        ctx.mappingFailedTargets.add(target.className);
        ctx.resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: "No mapping found" });
      }
    } catch (mapErr) {
      ctx.warnings.push(
        `Mapping lookup failed for class "${resolvedClassName}" while preparing ${ctx.signatureLookupMapping} lookup; using "${obfuscatedName}" for lookup.`
      );
      ctx.mappingFailedTargets.add(target.className);
      ctx.resolutionTrace?.push({ target: target.className, step: "mapping", input: resolvedClassName, output: obfuscatedName, success: false, detail: mapErr instanceof Error ? mapErr.message : String(mapErr) });
    }
  }

  try {
    const sig = await svc.explorerService.getSignature({
      fqn: obfuscatedName,
      jarPath: ctx.jarPath,
      access: "all"
    });
    ctx.warnings.push(...sig.warnings);
    ctx.resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: `${sig.methods.length} methods, ${sig.fields.length} fields`, success: true });

    let constructors = sig.constructors;
    let methods = sig.methods;
    let fields = sig.fields;

    if (ctx.requestedMapping !== ctx.signatureLookupMapping) {
      try {
        const [ctorResult, methodResult, fieldResult] = await Promise.all([
          svc.remapSignatureMembers(
            sig.constructors,
            "method",
            ctx.version,
            ctx.signatureLookupMapping,
            ctx.requestedMapping,
            ctx.currentSourcePriority,
            ctx.warnings,
            ctx.input.projectPath,
            ctx.input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.methods,
            "method",
            ctx.version,
            ctx.signatureLookupMapping,
            ctx.requestedMapping,
            ctx.currentSourcePriority,
            ctx.warnings,
            ctx.input.projectPath,
            ctx.input.gradleUserHome
          ),
          svc.remapSignatureMembers(
            sig.fields,
            "field",
            ctx.version,
            ctx.signatureLookupMapping,
            ctx.requestedMapping,
            ctx.currentSourcePriority,
            ctx.warnings,
            ctx.input.projectPath,
            ctx.input.gradleUserHome
          )
        ]);
        constructors = ctorResult.members;
        methods = methodResult.members;
        fields = fieldResult.members;

        const targetFailed = new Set<string>();
        for (const n of ctorResult.failedNames) targetFailed.add(n);
        for (const n of methodResult.failedNames) targetFailed.add(n);
        for (const n of fieldResult.failedNames) targetFailed.add(n);
        if (targetFailed.size > 0) {
          ctx.remapFailedMembers.set(target.className, targetFailed);
          ctx.resolutionTrace?.push({ target: target.className, step: "remap", input: `${targetFailed.size} members`, output: "failed", success: false });
        } else {
          ctx.resolutionTrace?.push({ target: target.className, step: "remap", input: `${methods.length + fields.length} members`, output: "remapped", success: true });
        }
      } catch (remapErr) {
        ctx.warnings.push(
          `Member remapping failed for "${resolvedClassName}"; falling back to ${ctx.signatureLookupMapping} names. ` +
          `Member names shown may be in the ${ctx.signatureLookupMapping} runtime namespace.`
        );
        ctx.mappingApplied = ctx.signatureLookupMapping;
        ctx.wholeRemapFailedTargets.add(target.className);
        ctx.resolutionTrace?.push({
          target: target.className,
          step: "remap",
          input: resolvedClassName,
          output: `${ctx.signatureLookupMapping} fallback`,
          success: false,
          detail: remapErr instanceof Error ? remapErr.message : String(remapErr)
        });
      }
    }

    ctx.targetMembers.set(target.className, {
      className: target.className,
      constructors,
      methods,
      fields
    });
  } catch (sigErr) {
    ctx.warnings.push(`Could not load signature for class "${resolvedClassName}" (obfuscated: "${obfuscatedName}").`);
    ctx.resolutionTrace?.push({ target: target.className, step: "signature", input: obfuscatedName, output: "CLASS_NOT_FOUND", success: false, detail: sigErr instanceof Error ? sigErr.message : String(sigErr) });

    try {
      const existenceCheck = await svc.mappingService.checkSymbolExists({
        version: ctx.version, kind: "class", name: resolvedClassName,
        sourceMapping: ctx.requestedMapping, nameMode: "auto", sourcePriority: ctx.currentSourcePriority,
        gradleUserHome: ctx.input.gradleUserHome
      });
      if (existenceCheck.resolved) {
        ctx.symbolExistsButSignatureFailed.add(target.className);
        ctx.resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "exists in mapping graph", success: true });
      } else {
        ctx.resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "not found", success: false });
      }
    } catch {
      ctx.signatureFailedTargets.add(target.className);
      ctx.resolutionTrace?.push({ target: target.className, step: "fallback-check", input: resolvedClassName, output: "check failed", success: false });
    }
  }

  const targetElapsed = performance.now() - targetStartedAt;
  const hadToolIssue =
    ctx.mappingFailedTargets.has(target.className) ||
    ctx.signatureFailedTargets.has(target.className) ||
    ctx.symbolExistsButSignatureFailed.has(target.className) ||
    ctx.remapFailedMembers.has(target.className) ||
    ctx.wholeRemapFailedTargets.has(target.className);
  const completedOutcome: MixinTargetOutcome = hadToolIssue
    ? {
        targetClass: target.className,
        status: "tool-issue",
        elapsedMs: targetElapsed,
        reason: ctx.signatureFailedTargets.has(target.className)
          ? "signature-load-failed"
          : ctx.symbolExistsButSignatureFailed.has(target.className)
            ? "signature-load-failed-symbol-exists"
            : ctx.mappingFailedTargets.has(target.className)
              ? "mapping-failed"
              : ctx.wholeRemapFailedTargets.has(target.className)
                ? "member-remap-failed-whole"
                : "member-remap-failed"
      }
    : {
        targetClass: target.className,
        status: "ok",
        elapsedMs: targetElapsed
      };
  if (targetElapsed > ctx.stageBudgets.perTarget) {
    completedOutcome.slowTarget = true;
    completedOutcome.budgetMs = ctx.stageBudgets.perTarget;
  }
  return completedOutcome;
}

export async function runTargetLookupStage(svc: SourceService, ctx: MutableMixinPipelineContext): Promise<void> {
  const targetLookupStartedAt = await ctx.enterStage("target-lookup");
  if (ctx.testHooks?.beforeTargetLoop) {
    await ctx.testHooks.beforeTargetLoop();
  }

  const totalTargets = ctx.parsed.targets.length;
  for (let targetIndex = 0; targetIndex < totalTargets; targetIndex++) {
    const stageElapsed = performance.now() - targetLookupStartedAt;
    if (stageElapsed > ctx.stageBudgets.targetLookup) {
      ctx.stageBudgetExhausted = true;
      ctx.nextTargetIndex = targetIndex;
      break;
    }
    const target = ctx.parsed.targets[targetIndex];
    const outcome = await processSingleMixinTarget(svc, ctx, target, targetIndex);
    ctx.targetOutcomes.push(outcome);
    ctx.processedTargetCount += 1;
  }

  if (ctx.stageBudgetExhausted) {
    if (ctx.processedTargetCount === 0) {
      ctx.degradedReason = "stage-budget-pre-target";
      for (const remaining of ctx.parsed.targets) {
        ctx.skippedForValidator.add(remaining.className);
      }
    } else {
      ctx.degradedReason = "stage-budget";
      for (let j = ctx.nextTargetIndex; j < totalTargets; j++) {
        const remaining = ctx.parsed.targets[j];
        ctx.deferredTargetClasses.add(remaining.className);
        ctx.skippedForValidator.add(remaining.className);
        ctx.targetOutcomes.push({
          targetClass: remaining.className,
          status: "deferred-budget",
          reason: "stage-budget",
          budgetMs: ctx.stageBudgets.targetLookup
        });
      }
    }
  }

  if (ctx.healthReport) {
    const hasFailures =
      ctx.signatureFailedTargets.size > 0 ||
      ctx.mappingFailedTargets.size > 0 ||
      ctx.symbolExistsButSignatureFailed.size > 0;
    if (hasFailures && ctx.healthReport.overallHealthy) {
      ctx.healthReport.overallHealthy = false;
      ctx.healthReport.degradations.push(
        `${ctx.mappingFailedTargets.size} mapping failure(s), ${ctx.signatureFailedTargets.size} signature failure(s), ${ctx.symbolExistsButSignatureFailed.size} partial validation target(s).`
      );
    }
  }
}
