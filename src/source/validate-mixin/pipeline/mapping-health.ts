import { existsSync } from "node:fs";

import type { SourceService } from "../../../source-service.js";
import type { SourceMapping } from "../../../types.js";
import type { MutableMixinPipelineContext } from "../pipeline-context.js";

/**
 * Whether the mapping data required by `requestedMapping` is present.
 *
 * Mojang mappings are only on the resolution path for `"mojang"` requests.
 * `"yarn"`/`"intermediary"` requests resolve through Tiny mappings instead
 * and never touch Mojang mappings. `"obfuscated"` requests need neither —
 * the jar itself (checked separately via `jarAvailable`) is sufficient.
 */
function requiredMappingHealthy(
  requestedMapping: SourceMapping,
  health: { mojangMappingsAvailable: boolean; tinyMappingsAvailable: boolean }
): boolean {
  switch (requestedMapping) {
    case "mojang":
      return health.mojangMappingsAvailable;
    case "yarn":
    case "intermediary":
      return health.tinyMappingsAvailable;
    case "obfuscated":
      return true;
  }
}

export async function runMappingHealthStage(svc: SourceService, ctx: MutableMixinPipelineContext): Promise<void> {
  const mappingHealthStartedAt = await ctx.enterStage("mapping-health");
  try {
    const health = await svc.mappingService.checkMappingHealth({
      version: ctx.version,
      requestedMapping: ctx.requestedMapping,
      sourcePriority: ctx.currentSourcePriority,
      gradleUserHome: ctx.input.gradleUserHome
    });
    const jarAvailable = existsSync(ctx.jarPath);
    ctx.healthReport = {
      jarAvailable,
      jarPath: ctx.jarPath,
      mojangMappingsAvailable: health.mojangMappingsAvailable,
      tinyMappingsAvailable: health.tinyMappingsAvailable,
      memberRemapAvailable: health.memberRemapAvailable,
      overallHealthy: jarAvailable && requiredMappingHealthy(ctx.requestedMapping, health),
      degradations: [
        ...(jarAvailable ? [] : ["Game jar not found."]),
        ...health.degradations
      ]
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.healthReport = {
      jarAvailable: existsSync(ctx.jarPath),
      jarPath: ctx.jarPath,
      mojangMappingsAvailable: false,
      tinyMappingsAvailable: false,
      memberRemapAvailable: false,
      overallHealthy: false,
      degradations: [`Mapping health probe failed: ${reason}`]
    };
  }

  if (ctx.testHooks?.afterMappingHealth) {
    await ctx.testHooks.afterMappingHealth();
  }
  ctx.checkPreParseBudget("mapping-health", mappingHealthStartedAt, ctx.stageBudgets.mappingHealth);
}
