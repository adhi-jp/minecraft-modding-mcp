import { ERROR_CODES, createError } from "../errors.js";
import { log } from "../logger.js";
import type { SourceService } from "../source-service.js";
import type {
  GetArtifactFileInput,
  GetArtifactFileOutput,
  ListArtifactFilesInput,
  ListArtifactFilesOutput
} from "../source-service.js";
import { normalizeOptionalString, normalizePathStyle } from "./shared-utils.js";

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || limit === null) {
    return fallback;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(limit), max);
}

function truncateUtf8ToMaxBytes(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) {
    return content;
  }
  const buffer = Buffer.from(content, "utf8");
  let cut = Math.min(maxBytes, buffer.length);
  while (cut > 0 && (buffer[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return buffer.slice(0, cut).toString("utf8");
}

export async function getArtifactFile(svc: SourceService, input: GetArtifactFileInput): Promise<GetArtifactFileOutput> {
  const startedAt = Date.now();
  try {
    const artifact = svc.getArtifact(input.artifactId);
    const row = svc.filesRepo.getFileContent(artifact.artifactId, normalizePathStyle(input.filePath));
    if (!row) {
      throw createError({
        code: ERROR_CODES.FILE_NOT_FOUND,
        message: `Source file "${input.filePath}" was not found.`,
        details: { artifactId: input.artifactId, filePath: input.filePath }
      });
    }

    const maxBytes = clampLimit(input.maxBytes, svc.config.maxContentBytes, Number.MAX_SAFE_INTEGER);
    const fullBytes = Buffer.byteLength(row.content, "utf8");
    const truncated = fullBytes > maxBytes;
    const content = truncated ? truncateUtf8ToMaxBytes(row.content, maxBytes) : row.content;

    if (truncated) {
      log("warn", "source.get_file.truncated", {
        artifactId: input.artifactId,
        filePath: input.filePath,
        maxBytes,
        returnedBytes: Buffer.byteLength(content, "utf8"),
        fullBytes
      });
    }

    return {
      filePath: row.filePath,
      content,
      contentBytes: fullBytes,
      truncated,
      mappingApplied: artifact.mappingApplied ?? "obfuscated",
      returnedNamespace: artifact.mappingApplied ?? "obfuscated",
      artifactContents: svc.buildArtifactContentsSummary({
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        isDecompiled: artifact.isDecompiled,
        qualityFlags: artifact.qualityFlags
      })
    };
  } finally {
    svc.metrics.recordDuration("get_file_duration_ms", Date.now() - startedAt);
  }
}

export async function listArtifactFiles(svc: SourceService, input: ListArtifactFilesInput): Promise<ListArtifactFilesOutput> {
  const startedAt = Date.now();
  try {
    const artifact = svc.getArtifact(input.artifactId);
    const limit = clampLimit(input.limit, 200, 2000);
    const warnings: string[] = [];
    const page = svc.filesRepo.listFiles(artifact.artifactId, {
      limit,
      cursor: input.cursor,
      prefix: input.prefix
    });
    const normalizedPrefix = normalizeOptionalString(input.prefix);
    if (
      normalizedPrefix &&
      page.items.length === 0 &&
      (normalizedPrefix.startsWith("assets/") || normalizedPrefix.startsWith("data/"))
    ) {
      warnings.push(
        "Indexed artifacts currently include Java source only; non-Java resources are not indexed. Inspect the original jar on disk if you need assets or data files."
      );
    }
    return {
      items: page.items,
      nextCursor: page.nextCursor,
      mappingApplied: artifact.mappingApplied ?? "obfuscated",
      artifactContents: svc.buildArtifactContentsSummary({
        origin: artifact.origin,
        sourceJarPath: artifact.sourceJarPath,
        isDecompiled: artifact.isDecompiled,
        qualityFlags: artifact.qualityFlags
      }),
      warnings
    };
  } finally {
    svc.metrics.recordDuration("list_files_duration_ms", Date.now() - startedAt);
  }
}
