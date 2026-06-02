// Structured companion to the string `meta.warnings`. Each warning string is
// classified into a high-value family so agents can branch on category/severity
// without parsing prose. `meta.warnings` is kept unchanged; this is additive.

export type WarningCategory = "pagination" | "mapping" | "coverage" | "validation" | "general";

export type WarningSeverity = "warning" | "info";

export type WarningDetail = {
  /** Stable machine code for the warning family. */
  code: string;
  category: WarningCategory;
  severity: WarningSeverity;
  /** The original human-readable warning string. */
  message: string;
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
    test: /falling back to vanilla|resolution failed; falling back|sources jar\.?\s*Falling back|does not include net\.minecraft/i,
    code: "partial_coverage",
    category: "coverage",
    severity: "warning",
    affectedFields: ["scope"]
  }
];

function classifyWarning(message: string): WarningDetail {
  for (const rule of WARNING_RULES) {
    if (rule.test.test(message)) {
      return {
        code: rule.code,
        category: rule.category,
        severity: rule.severity,
        message,
        ...(rule.affectedFields ? { affectedFields: rule.affectedFields } : {})
      };
    }
  }
  return { code: "general", category: "general", severity: "info", message };
}

/** Build the structured `warningDetails[]` companion for a list of warning strings. */
export function classifyWarnings(warnings: string[]): WarningDetail[] {
  return warnings.map(classifyWarning);
}
