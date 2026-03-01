import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createError, ERROR_CODES } from "./errors.js";
import { log } from "./logger.js";
import { ModDecompileService } from "./mod-decompile-service.js";
import { validateAndNormalizeJarPath } from "./path-resolver.js";

export type SearchModSourceSearchType = "class" | "method" | "field" | "content" | "all";

export type SearchModSourceInput = {
  jarPath: string;
  query: string;
  searchType?: SearchModSourceSearchType;
  limit?: number;
};

export type SearchModSourceHit = {
  type: "class" | "method" | "field" | "content";
  name: string;
  file: string;
  line?: number;
  context?: string;
};

export type SearchModSourceOutput = {
  query: string;
  searchType: SearchModSourceSearchType;
  hits: SearchModSourceHit[];
  totalHits: number;
  truncated: boolean;
  warnings: string[];
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 200;
const CONTEXT_LINES = 1;

const METHOD_PATTERN = /^\s*(public|private|protected)\s+.*\(/;
const FIELD_PATTERN = /^\s*(public|private|protected)\s+(?:static\s+)?(?:final\s+)?[\w<>,\[\]?]+\s+\w+\s*[;=]/;

function buildRegex(query: string): RegExp | undefined {
  try {
    return new RegExp(query, "gi");
  } catch {
    // If the query is not valid regex, escape it and use as literal
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(escaped, "gi");
    } catch {
      return undefined;
    }
  }
}

function classifyLine(line: string): "method" | "field" | "content" {
  if (METHOD_PATTERN.test(line)) return "method";
  if (FIELD_PATTERN.test(line)) return "field";
  return "content";
}

function extractContext(lines: string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - CONTEXT_LINES);
  const end = Math.min(lines.length - 1, lineIndex + CONTEXT_LINES);
  return lines.slice(start, end + 1).join("\n");
}

function filePathToClassName(filePath: string): string {
  return filePath.replace(/\.java$/, "").replaceAll("/", ".");
}

export class ModSearchService {
  private readonly modDecompileService: ModDecompileService;

  constructor(modDecompileService: ModDecompileService) {
    this.modDecompileService = modDecompileService;
  }

  async searchModSource(input: SearchModSourceInput): Promise<SearchModSourceOutput> {
    const jarPath = validateAndNormalizeJarPath(input.jarPath);
    const query = input.query.trim();
    const searchType = input.searchType ?? "all";
    const requestedLimit = Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT));
    const limit = Math.min(requestedLimit, MAX_LIMIT);

    if (!query) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: "query must be non-empty."
      });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `query exceeds max length of ${MAX_QUERY_LENGTH} characters.`,
        details: { queryLength: query.length, maxLength: MAX_QUERY_LENGTH }
      });
    }

    const regex = buildRegex(query);
    if (!regex) {
      throw createError({
        code: ERROR_CODES.INVALID_INPUT,
        message: `Invalid search query: "${query}".`,
        details: { query }
      });
    }

    const warnings: string[] = [];
    if (requestedLimit > MAX_LIMIT) {
      warnings.push(`limit was clamped to ${MAX_LIMIT} from ${requestedLimit}.`);
    }
    const startedAt = Date.now();

    const decompileResult = await this.modDecompileService.decompileModJar({ jarPath });
    const outputDir = decompileResult.outputDir;
    warnings.push(...decompileResult.warnings);
    const classNames = decompileResult.files ?? [];

    const hits: SearchModSourceHit[] = [];
    let totalHits = 0;
    let reachedLimit = false;

    for (const className of classNames) {
      if (hits.length >= limit) {
        reachedLimit = true;
        break;
      }

      const filePath = className.replaceAll(".", "/") + ".java";

      // Class name search: check if the simple class name matches
      if (searchType === "class" || searchType === "all") {
        const simpleClassName = className.split(".").pop() ?? className;
        regex.lastIndex = 0;
        if (regex.test(simpleClassName)) {
          totalHits++;
          if (hits.length < limit) {
            hits.push({
              type: "class",
              name: className,
              file: filePath
            });
          }
          // If searching only classes, skip content search for this file
          if (searchType === "class") continue;
        }
      }

      // Content/method/field search: read and scan the file
      if (searchType === "method" || searchType === "field" || searchType === "content" || searchType === "all") {
        let content: string;
        try {
          content = readFileSync(join(outputDir, filePath), "utf8");
        } catch {
          // File might not exist at the expected path, skip
          continue;
        }

        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (hits.length >= limit) {
            reachedLimit = true;
            break;
          }

          regex.lastIndex = 0;
          if (!regex.test(lines[i])) continue;

          const lineType = classifyLine(lines[i]);

          // Filter by search type
          if (searchType !== "all" && searchType !== lineType) continue;

          totalHits++;
          if (hits.length < limit) {
            hits.push({
              type: lineType,
              name: lineType === "content" ? className : extractSymbolName(lines[i], lineType),
              file: filePath,
              line: i + 1,
              context: extractContext(lines, i)
            });
          }
        }
      }
    }

    log("info", "mod-search.done", {
      jarPath,
      query,
      searchType,
      hitCount: hits.length,
      durationMs: Date.now() - startedAt
    });

    return {
      query,
      searchType,
      hits,
      totalHits,
      truncated: reachedLimit,
      warnings
    };
  }
}

function extractSymbolName(line: string, type: "method" | "field"): string {
  const trimmed = line.trim();
  if (type === "method") {
    // Extract method name: last identifier before '('
    const match = trimmed.match(/(\w+)\s*\(/);
    return match?.[1] ?? trimmed.slice(0, 60);
  }
  // Extract field name: last identifier before '=' or ';'
  const match = trimmed.match(/(\w+)\s*[;=]/);
  return match?.[1] ?? trimmed.slice(0, 60);
}
