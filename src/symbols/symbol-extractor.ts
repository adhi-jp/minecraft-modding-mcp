export interface ExtractedSymbol {
  symbolKind: "class" | "interface" | "enum" | "record" | "method" | "field";
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

const CLASS_DECLARATION = /^(?:\s*@[\w.]+\s+)*(?:\s*(?:public|private|protected|abstract|final|sealed|non-sealed|static)\s+)*\s*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;
const METHOD_DECLARATION = /^(?:\s*@[\w.]+\s+)*[^{;]*?\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:\{|;)/;
const FIELD_DECLARATION = /^(?:\s*@[\w.]+\s+)*[^\s][\w<>\[\],.?]+\s+([A-Za-z_$][\w$]*)\s*(?:=|;|,)/;
const NOISE_TOKENS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw"]);

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function isNoiseToken(token: string): boolean {
  return NOISE_TOKENS.has(token);
}

function lineIndexToLine(lineNo: number): number {
  return lineNo + 1;
}

export function extractSymbolsFromSource(filePath: string, content: string): Array<ExtractedSymbol> {
  const lines = content.split(/\r?\n/);
  const symbols: ExtractedSymbol[] = [];
  const qualifiedName = filePath.replace(/\.java$/, "").replaceAll("/", ".");

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = normalizeLine(rawLine);
    if (!line) {
      continue;
    }

    const classMatch = line.match(CLASS_DECLARATION);
    if (classMatch) {
      const symbolKind = classMatch[1] as ExtractedSymbol["symbolKind"];
      const symbolName = classMatch[2];
      if (symbolName && !isNoiseToken(symbolName)) {
        symbols.push({
          symbolKind,
          symbolName,
          qualifiedName,
          line: lineIndexToLine(index)
        });
      }
      continue;
    }

    const methodMatch = line.match(METHOD_DECLARATION);
    if (methodMatch) {
      const symbolName = methodMatch[1];
      if (symbolName && !isNoiseToken(symbolName)) {
        symbols.push({
          symbolKind: "method",
          symbolName,
          qualifiedName,
          line: lineIndexToLine(index)
        });
      }
      continue;
    }

    const fieldMatch = line.match(FIELD_DECLARATION);
    if (fieldMatch) {
      const symbolName = fieldMatch[1];
      if (symbolName && !isNoiseToken(symbolName)) {
        symbols.push({
          symbolKind: "field",
          symbolName,
          qualifiedName,
          line: lineIndexToLine(index)
        });
      }
    }
  }

  return symbols;
}
