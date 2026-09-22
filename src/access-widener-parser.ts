/**
 * Parser for Fabric Access Widener files (.accesswidener).
 * Format: line-based, tab/space separated.
 * Header: `accessWidener v2 intermediary`
 * Entry:  `accessible class net/minecraft/foo/Bar`
 *         `accessible method net/minecraft/foo/Bar baz (I)V`
 *         `mutable field net/minecraft/foo/Bar qux I`
 */

export type AccessWidenerEntry = {
  line: number;
  kind: "accessible" | "extendable" | "mutable";
  transitive?: boolean;
  targetKind: "class" | "method" | "field";
  target: string;
  owner?: string;
  name?: string;
  descriptor?: string;
};

export type ParsedAccessWidener = {
  headerVersion: string;
  namespace: string;
  entries: AccessWidenerEntry[];
  parseWarnings: string[];
  /**
   * Count of entry lines the parser had to drop for malformed syntax (unknown
   * kind/target kind, incomplete entry, missing descriptor). Excludes the
   * purely informational header-line warnings. A caller-visible validator
   * uses this to force its verdict invalid even when `entries` is empty.
   * Optional (defaults to 0) so hand-built `ParsedAccessWidener` fixtures
   * that predate this field keep working.
   */
  rejectedEntryCount?: number;
  /**
   * The line number the `accessWidener <version> <namespace>` header was
   * found on, when a syntactically well-formed header line was found (set
   * even when its version is unsupported). Undefined when no header line
   * matched the expected format at all; callers fall back to line 1.
   */
  headerLine?: number;
};

const VALID_KINDS = new Set(["accessible", "extendable", "mutable"]);
const VALID_TARGET_KINDS = new Set(["class", "method", "field"]);

export function parseAccessWidener(content: string): ParsedAccessWidener {
  const lines = content.split(/\r?\n/);
  const parseWarnings: string[] = [];
  const entries: AccessWidenerEntry[] = [];
  let headerVersion = "";
  let namespace = "";
  let rejectedEntryCount = 0;
  let headerLine: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const lineNum = i + 1;

    // Skip blank lines and comments
    if (!raw || raw.startsWith("#")) continue;

    // Header line
    if (!headerVersion) {
      const parts = raw.split(/\s+/);
      if (parts[0] === "accessWidener" && parts.length >= 3) {
        headerVersion = parts[1];
        namespace = parts[2];
        headerLine = lineNum;
      } else {
        parseWarnings.push(`Line ${lineNum}: Expected accessWidener header, got: "${raw}"`);
      }
      continue;
    }

    // Entry lines
    const parts = raw.split(/\s+/);
    if (parts.length < 3) {
      parseWarnings.push(`Line ${lineNum}: Incomplete entry: "${raw}"`);
      rejectedEntryCount++;
      continue;
    }

    const kind = parts[0];
    const targetKind = parts[1];

    const transitive = kind.startsWith("transitive-");
    const baseKind = transitive ? kind.slice("transitive-".length) : kind;
    if (!VALID_KINDS.has(baseKind)) {
      parseWarnings.push(`Line ${lineNum}: Unknown access kind "${kind}".`);
      rejectedEntryCount++;
      continue;
    }
    if (!VALID_TARGET_KINDS.has(targetKind)) {
      parseWarnings.push(`Line ${lineNum}: Unknown target kind "${targetKind}".`);
      rejectedEntryCount++;
      continue;
    }

    const validKind = baseKind as AccessWidenerEntry["kind"];
    const validTargetKind = targetKind as AccessWidenerEntry["targetKind"];

    if (validTargetKind === "class") {
      entries.push({ line: lineNum, kind: validKind, transitive, targetKind: validTargetKind, target: parts[2] });
    } else if (parts.length >= 5) {
      // method/field: <kind> <targetKind> <owner> <name> <descriptor>
      entries.push({
        line: lineNum,
        kind: validKind,
        transitive,
        targetKind: validTargetKind,
        target: parts[2],
        owner: parts[2],
        name: parts[3],
        descriptor: parts[4]
      });
    } else {
      parseWarnings.push(`Line ${lineNum}: ${validTargetKind} entry requires owner, name, and descriptor.`);
      rejectedEntryCount++;
    }
  }

  if (!headerVersion) {
    parseWarnings.push("Missing accessWidener header.");
  }

  return { headerVersion, namespace, entries, parseWarnings, rejectedEntryCount, headerLine };
}
