import { extractSymbolsFromSource } from "../symbols/symbol-extractor.js";

export type DecompiledMember = {
  name: string;
  line: number;
  kind: "constructor" | "field" | "method";
};

export function extractClassMetadata(filePath: string, content: string): string {
  const lines = content.split(/\r?\n/);
  const symbols = extractSymbolsFromSource(filePath, content);
  const outputParts: string[] = [];

  // Include package + import header (lines before first symbol declaration)
  const firstSymbolLine = symbols.length > 0 ? symbols[0]!.line : lines.length + 1;
  for (let i = 0; i < Math.min(firstSymbolLine - 1, lines.length); i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("package ") || trimmed.startsWith("import ") || trimmed === "") {
      outputParts.push(line);
    }
  }

  // Add each symbol's declaration line
  for (const symbol of symbols) {
    const lineIndex = symbol.line - 1;
    if (lineIndex >= 0 && lineIndex < lines.length) {
      const prefix = symbol.symbolKind === "class" || symbol.symbolKind === "interface" ||
        symbol.symbolKind === "enum" || symbol.symbolKind === "record"
        ? `\n// [${symbol.symbolKind}] line ${symbol.line}`
        : `// [${symbol.symbolKind}] line ${symbol.line}`;
      outputParts.push(prefix);
      outputParts.push(lines[lineIndex]!);
    }
  }

  return outputParts.join("\n");
}

export function extractDecompiledMembers(
  className: string,
  filePath: string,
  content: string
): { constructors: DecompiledMember[]; fields: DecompiledMember[]; methods: DecompiledMember[] } {
  const symbols = extractSymbolsFromSource(filePath, content);
  const simpleName = className.split(/[.$]/).at(-1) ?? className;
  const lines = content.split(/\r?\n/);
  const body = computeBraceRange(lines, symbols, simpleName);
  if (!body) {
    return { constructors: [], fields: [], methods: [] };
  }
  const depths = computeLineBraceDepths(lines);
  const baseDepth = depths[body.declarationLine - 1] ?? 0;
  const nestedRanges = computeNestedTypeRanges(lines, symbols, body);
  const constructors: DecompiledMember[] = [];
  const fields: DecompiledMember[] = [];
  const methods: DecompiledMember[] = [];
  for (const symbol of symbols) {
    if (symbol.line <= body.declarationLine || symbol.line > body.endLine) {
      continue;
    }
    if (nestedRanges.some((range) => symbol.line >= range.declarationLine && symbol.line <= range.endLine)) {
      continue;
    }
    const lineDepth = depths[symbol.line - 1] ?? baseDepth;
    // Declarations directly inside the class body sit at baseDepth+1; anything
    // deeper is a method/constructor body, an initializer block, etc.
    if (lineDepth !== baseDepth + 1) {
      continue;
    }
    if (symbol.symbolKind === "method") {
      if (symbol.symbolName === simpleName) {
        constructors.push({ name: "<init>", line: symbol.line, kind: "constructor" });
      } else {
        methods.push({ name: symbol.symbolName, line: symbol.line, kind: "method" });
      }
    } else if (symbol.symbolKind === "field") {
      fields.push({ name: symbol.symbolName, line: symbol.line, kind: "field" });
    }
  }
  return { constructors, fields, methods };
}

export function computeLineBraceDepths(lines: string[]): number[] {
  const depths: number[] = new Array(lines.length).fill(0);
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    // Entry depth for this line = depth observed before any brace on it.
    depths[i] = depth;
    const stripped = (lines[i] ?? "")
      .replace(/\/\/.*/g, "")
      .replace(/"(?:\\.|[^"\\])*"/g, "\"\"")
      .replace(/'(?:\\.|[^'\\])*'/g, "''");
    for (const char of stripped) {
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
    }
  }
  return depths;
}

export function computeBraceRange(
  lines: string[],
  symbols: Array<{ symbolKind: string; symbolName: string; line: number }>,
  simpleName: string
): { declarationLine: number; endLine: number } | undefined {
  const classSymbol = symbols.find((symbol) =>
    (symbol.symbolKind === "class" || symbol.symbolKind === "interface"
      || symbol.symbolKind === "enum" || symbol.symbolKind === "record")
    && symbol.symbolName === simpleName
  );
  if (!classSymbol) {
    return undefined;
  }
  return scanBraceRange(lines, classSymbol.line);
}

export function scanBraceRange(
  lines: string[],
  declarationLine: number
): { declarationLine: number; endLine: number } {
  let depth = 0;
  let started = false;
  for (let i = declarationLine - 1; i < lines.length; i += 1) {
    const stripped = (lines[i] ?? "")
      .replace(/\/\/.*/g, "")
      .replace(/"(?:\\.|[^"\\])*"/g, "\"\"");
    for (const char of stripped) {
      if (char === "{") {
        depth += 1;
        started = true;
      } else if (char === "}") {
        depth -= 1;
        if (started && depth === 0) {
          return { declarationLine, endLine: i + 1 };
        }
      }
    }
  }
  return { declarationLine, endLine: lines.length };
}

export function computeNestedTypeRanges(
  lines: string[],
  symbols: Array<{ symbolKind: string; line: number }>,
  outerBody: { declarationLine: number; endLine: number }
): Array<{ declarationLine: number; endLine: number }> {
  const ranges: Array<{ declarationLine: number; endLine: number }> = [];
  for (const candidate of symbols) {
    if (candidate.symbolKind !== "class" && candidate.symbolKind !== "interface"
      && candidate.symbolKind !== "enum" && candidate.symbolKind !== "record") {
      continue;
    }
    if (candidate.line <= outerBody.declarationLine || candidate.line > outerBody.endLine) {
      continue;
    }
    if (ranges.some((range) => candidate.line >= range.declarationLine && candidate.line <= range.endLine)) {
      continue;
    }
    const nestedRange = scanBraceRange(lines, candidate.line);
    ranges.push(nestedRange);
  }
  return ranges;
}
