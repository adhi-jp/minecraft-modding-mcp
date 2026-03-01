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
};

const VALID_KINDS = new Set(["accessible", "extendable", "mutable"]);
const VALID_TARGET_KINDS = new Set(["class", "method", "field"]);

export function parseAccessWidener(content: string): ParsedAccessWidener {
  const lines = content.split(/\r?\n/);
  const parseWarnings: string[] = [];
  const entries: AccessWidenerEntry[] = [];
  let headerVersion = "";
  let namespace = "";

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
      } else {
        parseWarnings.push(`Line ${lineNum}: Expected accessWidener header, got: "${raw}"`);
      }
      continue;
    }

    // Entry lines
    const parts = raw.split(/\s+/);
    if (parts.length < 3) {
      parseWarnings.push(`Line ${lineNum}: Incomplete entry: "${raw}"`);
      continue;
    }

    const kind = parts[0];
    const targetKind = parts[1];

    if (!VALID_KINDS.has(kind)) {
      parseWarnings.push(`Line ${lineNum}: Unknown access kind "${kind}".`);
      continue;
    }
    if (!VALID_TARGET_KINDS.has(targetKind)) {
      parseWarnings.push(`Line ${lineNum}: Unknown target kind "${targetKind}".`);
      continue;
    }

    const validKind = kind as AccessWidenerEntry["kind"];
    const validTargetKind = targetKind as AccessWidenerEntry["targetKind"];

    if (validTargetKind === "class") {
      entries.push({ line: lineNum, kind: validKind, targetKind: validTargetKind, target: parts[2] });
    } else if (parts.length >= 5) {
      // method/field: <kind> <targetKind> <owner> <name> <descriptor>
      entries.push({
        line: lineNum,
        kind: validKind,
        targetKind: validTargetKind,
        target: parts[2],
        owner: parts[2],
        name: parts[3],
        descriptor: parts[4]
      });
    } else {
      parseWarnings.push(`Line ${lineNum}: ${validTargetKind} entry requires owner, name, and descriptor.`);
    }
  }

  if (!headerVersion) {
    parseWarnings.push("Missing accessWidener header.");
  }

  return { headerVersion, namespace, entries, parseWarnings };
}
