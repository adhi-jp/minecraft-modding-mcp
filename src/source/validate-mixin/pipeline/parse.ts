import { parseMixinSource } from "../../../mixin-parser.js";
import type { MutableMixinPipelineContext } from "../pipeline-context.js";

export async function runParseStage(ctx: MutableMixinPipelineContext): Promise<void> {
  const parseStartedAt = await ctx.enterStage("parse");
  ctx.parsed = parseMixinSource(ctx.source);

  if (ctx.testHooks?.afterParse) {
    await ctx.testHooks.afterParse();
  }
  ctx.checkPreParseBudget("parse", parseStartedAt, ctx.stageBudgets.parse);
}
