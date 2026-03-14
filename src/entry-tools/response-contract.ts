export const DETAIL_LEVELS = ["summary", "standard", "full"] as const;

export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const CANONICAL_INCLUDE_GROUPS = [
  "warnings",
  "provenance",
  "candidates",
  "members",
  "source",
  "files",
  "samples",
  "diff",
  "issues",
  "timeline",
  "matrix",
  "entries",
  "workspace",
  "health",
  "recovery",
  "paths",
  "owners",
  "preview",
  "cacheEntries",
  "timings",
  "artifact",
  "classes",
  "registry"
] as const;

export type IncludeGroup = (typeof CANONICAL_INCLUDE_GROUPS)[number];

export type SummaryStatus =
  | "ok"
  | "partial"
  | "ambiguous"
  | "not_found"
  | "invalid"
  | "blocked"
  | "changed"
  | "unchanged";

export type NextAction = {
  tool: string;
  params: Record<string, unknown>;
};

export type Summary = {
  status: SummaryStatus;
  headline: string;
  subject?: Record<string, unknown>;
  counts?: Record<string, number>;
  nextActions?: NextAction[];
  notes?: string[];
};

export type TruncationMeta = {
  didTruncate: true;
  reason: "limit";
  omittedGroups?: string[];
  nextActions?: NextAction[];
};

const INCLUDE_ORDER = new Map<string, number>(
  CANONICAL_INCLUDE_GROUPS.map((group, index) => [group, index])
);

export function normalizeIncludeGroups(include: readonly string[] | undefined): string[] {
  if (!include || include.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const group of include) {
    if (!group || seen.has(group)) {
      continue;
    }
    seen.add(group);
    deduped.push(group);
  }

  deduped.sort((left, right) => {
    const leftIndex = INCLUDE_ORDER.get(left);
    const rightIndex = INCLUDE_ORDER.get(right);
    if (leftIndex == null && rightIndex == null) {
      return left.localeCompare(right);
    }
    if (leftIndex == null) {
      return 1;
    }
    if (rightIndex == null) {
      return -1;
    }
    return leftIndex - rightIndex;
  });

  return deduped;
}

export function createNextAction(tool: string, params: Record<string, unknown>): NextAction {
  return { tool, params };
}

export function createSummarySubject(
  fields: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  );
}

export function createTruncationMeta(input: {
  omittedGroups?: string[];
  nextActions?: NextAction[];
}): TruncationMeta {
  return {
    didTruncate: true,
    reason: "limit",
    ...(input.omittedGroups?.length ? { omittedGroups: [...input.omittedGroups] } : {}),
    ...(input.nextActions?.length ? { nextActions: [...input.nextActions] } : {})
  };
}

export function buildEntryToolMeta(input: {
  detail: DetailLevel;
  include?: readonly string[];
  warnings?: readonly string[];
  truncated?: TruncationMeta;
  pagination?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    warnings: [...(input.warnings ?? [])],
    detailApplied: input.detail,
    ...(input.include && input.include.length > 0
      ? { includeApplied: normalizeIncludeGroups(input.include) }
      : {}),
    ...(input.truncated ? { truncated: input.truncated } : {}),
    ...(input.pagination ? { pagination: input.pagination } : {})
  };
}

export function buildEntryToolResult(input: {
  task: string;
  summary: Summary;
  detail: DetailLevel;
  include?: readonly string[];
  blocks?: Record<string, unknown>;
  alwaysBlocks?: readonly string[];
}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    task: input.task,
    summary: input.summary
  };

  const include = new Set(normalizeIncludeGroups(input.include));
  const alwaysBlocks = new Set(input.alwaysBlocks ?? []);

  for (const [key, value] of Object.entries(input.blocks ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (alwaysBlocks.has(key) || input.detail !== "summary" || include.has(key)) {
      result[key] = value;
    }
  }

  return result;
}
