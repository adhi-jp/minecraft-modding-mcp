// Structured companion to the string `meta.warnings`. Each warning string is
// classified into a high-value family so agents can branch on category/severity
// without parsing prose. The original text is NOT duplicated here; each entry
// references its warning by position via `index` (read `meta.warnings[index]`).

export type WarningCategory = "pagination" | "mapping" | "coverage" | "validation" | "general";

export type WarningSeverity = "warning" | "info";

export type WarningDetail = {
  /** Stable machine code for the warning family. */
  code: string;
  category: WarningCategory;
  severity: WarningSeverity;
  /** Index into `meta.warnings[]` that holds the original human-readable text. */
  index: number;
  /** Input fields a caller can adjust to address the warning, when applicable. */
  affectedFields?: string[];
};

type WarningRule = {
  test: RegExp;
  code: string;
  category: WarningCategory;
  severity: WarningSeverity;
  affectedFields?: string[];
};

// First matching rule wins; more specific patterns precede broader ones.
const WARNING_RULES: WarningRule[] = [
  {
    test: /Member list was truncated|truncated to \d+ (entries|rows)|Raise maxCandidates|Raise maxRows/i,
    code: "result_truncated",
    category: "pagination",
    severity: "info",
    affectedFields: ["maxMembers", "maxRows", "maxCandidates", "cursor"]
  },
  {
    test: /\bwas clamped to\b/i,
    code: "input_clamped",
    category: "validation",
    severity: "info"
  },
  {
    test: /are not indexed|non-Java resources are not indexed/i,
    code: "resource_not_indexed",
    category: "coverage",
    severity: "info"
  },
  {
    test: /namespace translation requires a version|could not be applied because the artifact has no version|Could not (re)?map .* (from .* to|to .* namespace)|Remap failed for|Mapping lookup failed|No exact class symbol matched|Unsupported .* namespace/i,
    code: "namespace_fallback",
    category: "mapping",
    severity: "warning",
    affectedFields: ["mapping", "version"]
  },
  {
    // compare-versions: the filter is fine but matched nothing, which used to
    // be indistinguishable from "nothing changed".
    test: /packageFilter ".*" matched no class/i,
    code: "filter_matched_nothing",
    category: "validation",
    severity: "warning",
    affectedFields: ["packageFilter"]
  },
  {
    // compare-versions could not lift the jars out of the obfuscated namespace.
    // The cause is the version whose mappings would not load, so `version` leads;
    // packageFilter follows because it is the field the fallback also invalidates.
    test: /compared in the OBFUSCATED namespace/i,
    code: "namespace_fallback",
    category: "mapping",
    severity: "warning",
    affectedFields: ["version", "packageFilter"]
  },
  {
    test: /falling back to vanilla|resolution failed; falling back|sources jar\.?\s*Falling back|(?:does not include|excludes) net\.minecraft/i,
    code: "partial_coverage",
    category: "coverage",
    severity: "warning",
    affectedFields: ["scope"]
  }
];

function classifyWarning(message: string, index: number): WarningDetail {
  for (const rule of WARNING_RULES) {
    if (rule.test.test(message)) {
      return {
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        index,
        ...(rule.affectedFields ? { affectedFields: rule.affectedFields } : {})
      };
    }
  }
  return { code: "general", category: "general", severity: "info", index };
}

/**
 * Build the structured `warningDetails[]` companion for a list of warning strings.
 * The mapping is 1:1 and order-preserving, so each entry's `index` equals its
 * position and dereferences the text via `warnings[index]`.
 */
export function classifyWarnings(warnings: string[]): WarningDetail[] {
  return warnings.map((message, index) => classifyWarning(message, index));
}

/**
 * Cap of structured warningDetails entries emitted at `detail:"summary"`.
 */
export const SUMMARY_WARNING_DETAIL_CAP = 5;

/**
 * At `detail:"summary"` the structured warningDetails companion is capped to a small
 * representative set to keep responses lean. The full human-readable text still lives
 * in `meta.warnings[]`, and each kept entry's `index` continues to dereference it, so
 * no information is lost — only the redundant structured duplicate is trimmed. Standard
 * and full detail return the companion unchanged.
 */
export function capWarningDetailsForSummary(
  warningDetails: WarningDetail[],
  isSummary: boolean
): WarningDetail[] {
  if (!isSummary || warningDetails.length <= SUMMARY_WARNING_DETAIL_CAP) {
    return warningDetails;
  }
  return warningDetails.slice(0, SUMMARY_WARNING_DETAIL_CAP);
}
