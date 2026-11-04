import type { ServerContext, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";

import type { SourceService } from "../source-service.js";
import type { Config } from "../types.js";
import type { StageEmitter } from "../stage-emitter.js";
import type { ToolExecutionGate } from "../tool-execution-gate.js";
import type { DetailLevel } from "./schemas.js";

/** Every per-item or per-call status a catalog tool may report. */
export const CATALOG_STATUSES = [
  "ok",
  "partial",
  "not_found",
  "ambiguous",
  "invalid",
  "unavailable",
  "blocked",
  "error"
] as const;

export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

export type CatalogWarningSeverity = "info" | "warning";

export type CatalogWarning = {
  code: string;
  severity: CatalogWarningSeverity;
  message: string;
};

/**
 * A suggested follow-up call. Entries without `template` are executable as
 * given and validate against the named tool's registered schema; `template`
 * entries carry `<placeholder>` values the caller fills in first.
 */
export type CatalogNextAction = {
  tool: string;
  params: Record<string, unknown>;
  reason?: string;
  template?: true;
};

/** A follow-up call a service suggested under an 8.x tool name. */
export type ServiceSuggestedCall = {
  tool: string;
  params: Record<string, unknown>;
  reason?: string;
};

export type CatalogPagination = {
  hasMore: boolean;
  nextCursor?: string;
};

export type CatalogTruncation = {
  field: string;
  limitedBy: string;
};

/** What a catalog handler hands back to the runner. */
export type CatalogHandlerOutput = {
  /**
   * The reply's `result`. When the spec declares a `detailProjection`, the
   * runner projects the primary payload for the requested `detail`.
   */
  result: Record<string, unknown>;
  /** Service warning strings or already structured warnings. */
  warnings?: ReadonlyArray<string | CatalogWarning>;
  /** Proposed catalog follow-up calls; the runner drops invalid ones. */
  nextActions?: readonly CatalogNextAction[];
  /** Follow-up calls the service named with 8.x tool names; the runner translates or drops them. */
  serviceSuggestedCalls?: readonly ServiceSuggestedCall[];
  pagination?: CatalogPagination;
  truncation?: readonly CatalogTruncation[];
};

/** The service calls catalog handlers make; the server passes its shared source service. */
export type CatalogServices = Pick<
  SourceService,
  | "listVersions"
  | "resolveArtifact"
  | "indexArtifact"
  | "listArtifactFiles"
  | "getArtifactFile"
  | "findClassIncludingNested"
  | "checkSymbolExists"
  | "getArtifact"
  | "reportedArtifactNamespace"
  | "getClassSource"
  | "getClassMembers"
  | "searchClassSource"
  | "findMapping"
  | "resolveMethodMappingExact"
  | "resolveWorkspaceSymbol"
  | "getClassApiMatrix"
  | "traceSymbolLifecycle"
  | "workspaceMappingService"
  | "compareVersions"
  | "getVersionLibraries"
  | "diffClassSignatures"
  | "getRegistryData"
  | "searchModSource"
  | "validateMixin"
  | "validateAccessWidener"
  | "validateAccessTransformer"
  | "probeMinecraftArtifact"
  | "explorerService"
  | "getRuntimeMetrics"
  | "config"
>;

export type CatalogCall = {
  tool: string;
  requestId: string;
  services: CatalogServices;
  /**
   * The server's loaded configuration. Reading it never constructs the source
   * service, so tools that do not need that service (NBT, the cache registry)
   * keep working when the cache database cannot be opened.
   */
  config: Config;
  /** The cache database, named when a raw SQLite failure is reported. */
  sqlitePath: string;
  serverContext?: ServerContext;
  /** Progress stages of this call, sent as `$/stageUpdate` notifications when the transport supports them. */
  stageEmitter?: StageEmitter;
};

/**
 * What each `detail` level keeps of a tool's primary payload (of each item
 * when the payload is a list). Fields named here are kept only from the given
 * level up; every other field, including the payload key itself and any
 * `status`, is kept at every level.
 */
export type CatalogDetailProjection = {
  /** The level used when the request omits `detail`; the input schema advertises the same default. */
  default: DetailLevel;
  minimumLevel: Readonly<Record<string, Exclude<DetailLevel, "summary">>>;
};

export type CatalogToolSpec<TInput = any> = {
  name: string;
  title?: string;
  description: string;
  annotations: ToolAnnotations;
  /** Validating input schema; control objects are strict. */
  inputSchema: z.ZodType<TInput>;
  /** Valid requests, used by the contract tests and the documentation. */
  examples: ReadonlyArray<Record<string, unknown>>;
  /** The statuses this tool's replies can carry. */
  statuses: readonly CatalogStatus[];
  /** The `result` key that carries the tool's answer. */
  primaryKey?: string;
  /** Tools with a `detail` input: what each level keeps of the primary payload. */
  detailProjection?: CatalogDetailProjection;
  handler: (input: TInput, call: CatalogCall) => Promise<CatalogHandlerOutput>;
};

/** Process-wide facilities a catalog call shares with the 8.x tools. */
export type CatalogRuntime = {
  heavyGate: ToolExecutionGate;
  isHeavy: (tool: string) => boolean;
  recordToolCall: (tool: string, durationMs: number) => void;
  sqlitePath: string;
  services: CatalogServices;
  /** The server's loaded configuration, handed to each call as `config`. */
  config: Config;
  /** The stage emitter of one call, built from its server context. */
  stageEmitterFor?: (serverContext?: ServerContext) => StageEmitter;
};
