import type { SourceService } from "../../../source-service.js";
import {
  type MutableMixinPipelineContext,
  normalizeMapping
} from "../pipeline-context.js";

export async function runResolveStage(svc: SourceService, ctx: MutableMixinPipelineContext): Promise<void> {
  const resolveStartedAt = await ctx.enterStage("resolve");

  let detectedMapping;
  if ((!ctx.input.mapping || ctx.input.preferProjectMapping) && ctx.input.projectPath) {
    try {
      const detection = await svc.workspaceMappingService.detectCompileMapping({ projectPath: ctx.input.projectPath });
      if (detection.resolved && detection.mappingApplied) {
        detectedMapping = detection.mappingApplied;
        ctx.mappingAutoDetected = true;
        ctx.warnings.push(`Auto-detected mapping '${detectedMapping}' from project configuration.`);
        ctx.warnings.push(...detection.warnings);
      } else {
        ctx.warnings.push(...detection.warnings);
      }
    } catch {
      // Detection failed — fall through to default
    }
  }

  ctx.requestedMapping = normalizeMapping(detectedMapping ?? ctx.input.mapping);
  ctx.mappingApplied = ctx.requestedMapping;

  if (ctx.input.preferProjectVersion && ctx.input.projectPath) {
    const detected = await svc.workspaceMappingService.detectProjectMinecraftVersion(ctx.input.projectPath);
    if (detected && detected !== ctx.version) {
      ctx.warnings.push(`Overriding version "${ctx.version}" with project version "${detected}" from gradle.properties.`);
    }
    ctx.version = detected ?? ctx.version;
  }

  ctx.signatureLookupMapping = "obfuscated";
  if (ctx.input.scope && ctx.input.scope !== "vanilla" && ctx.input.projectPath) {
    try {
      ctx.resolvedArtifact = await svc.resolveArtifact({
        target: { kind: "version", value: ctx.version },
        mapping: ctx.requestedMapping,
        sourcePriority: ctx.currentSourcePriority,
        projectPath: ctx.input.projectPath,
        gradleUserHome: ctx.input.gradleUserHome,
        scope: ctx.input.scope,
        preferProjectVersion: false
      });
      ctx.jarPath = ctx.resolvedArtifact.binaryJarPath ?? (await svc.versionService.resolveVersionJar(ctx.version)).jarPath;
      ctx.warnings.push(...ctx.resolvedArtifact.warnings);
      ctx.mappingApplied = ctx.resolvedArtifact.mappingApplied;
      ctx.signatureLookupMapping = ctx.resolvedArtifact.mappingApplied;
      if (ctx.resolvedArtifact.version) {
        ctx.version = ctx.resolvedArtifact.version;
      }
    } catch (scopeErr) {
      ctx.scopeFallback = {
        requested: ctx.input.scope,
        applied: "vanilla",
        reason: `Loom cache unavailable: ${scopeErr instanceof Error ? scopeErr.message : String(scopeErr)}`
      };
      ctx.warnings.push(`Scope "${ctx.input.scope}" resolution failed; falling back to vanilla. ${ctx.scopeFallback.reason}`);
      ctx.jarPath = (await svc.versionService.resolveVersionJar(ctx.version)).jarPath;
    }
  } else {
    ctx.jarPath = (await svc.versionService.resolveVersionJar(ctx.version)).jarPath;
  }

  if (ctx.jarPath.includes("-sources.jar")) {
    ctx.warnings.push(`Resolved jar appears to be a sources jar. Falling back to vanilla client jar.`);
    ctx.jarPath = (await svc.versionService.resolveVersionJar(ctx.version)).jarPath;
    ctx.signatureLookupMapping = "obfuscated";
    ctx.scopeFallback = {
      requested: ctx.input.scope ?? "vanilla",
      applied: "vanilla",
      reason: "Resolved jar was a sources jar, not a binary class jar."
    };
  }

  if (ctx.testHooks?.afterResolve) {
    await ctx.testHooks.afterResolve();
  }
  ctx.checkPreParseBudget("resolve", resolveStartedAt, ctx.stageBudgets.resolve);
}
