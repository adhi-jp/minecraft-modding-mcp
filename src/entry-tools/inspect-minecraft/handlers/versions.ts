import { buildEntryToolResult, createNextAction, createSummarySubject, type DetailLevel, type Summary } from "../../response-contract.js";
import { nextActionsOrUndefined } from "../../request-normalizers.js";
import { type InspectMinecraftDeps } from "../internal.js";
import { type InspectMinecraftInput } from "../../inspect-minecraft-service.js";

export async function handleVersions(
deps: InspectMinecraftDeps,
  input: InspectMinecraftInput,
  detail: DetailLevel,
  include: string[]
) {
  const versions = await deps.listVersions({
    includeSnapshots: input.includeSnapshots,
    limit: input.limit
  });
  const summary: Summary = {
    status: "ok",
    headline: `Found ${versions.totalAvailable} Minecraft versions.`,
    subject: createSummarySubject({
      task: "versions",
      kind: "versions",
      includeSnapshots: input.includeSnapshots === false ? undefined : input.includeSnapshots,
      limit: input.limit
    }),
    counts: {
      releases: versions.releases.length,
      snapshots: versions.snapshots?.length ?? 0
    },
    nextActions: nextActionsOrUndefined([
      createNextAction("inspect-minecraft", {
        task: "artifact",
        subject: {
          kind: "version",
          version: versions.latest.release ?? versions.releases[0]?.id
        }
      })
    ])
  };

  return {
    ...buildEntryToolResult({
      task: "versions",
      summary,
      detail,
      include,
      blocks: {
        versions: {
          latest: versions.latest,
          releases: detail === "summary" ? versions.releases.slice(0, 5) : versions.releases,
          snapshots: input.includeSnapshots ? versions.snapshots : undefined,
          cached: versions.cached
        }
      }
    }),
    warnings: []
  };
}
