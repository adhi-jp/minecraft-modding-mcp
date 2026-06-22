export interface ExtractedSymbol {
  symbolKind: "class" | "interface" | "enum" | "record" | "method" | "field";
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

// A type token may carry spaced generics (Map<String, Integer>), arrays (int[][]),
// wildcards (List<? extends Foo>), and FQNs (java.util.Map). It must not contain "=".
const TYPE_TOKEN = "[\\w.$][\\w.$<>\\[\\],?\\s]*";
const MODIFIER = "(?:public|private|protected|abstract|final|static|native|synchronized|default|strictfp|transient|volatile|sealed|non-sealed)";
const MODIFIER_OR_ANNOTATION_RUN = `(?:(?:@[\\w.]+|${MODIFIER})\\s+)*`;
const TYPE_PARAMS = "(?:<[^>]+>\\s*)?";
const THROWS_CLAUSE = "(?:\\s+throws\\s+[\\w.$,\\s]+)?";

const CLASS_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}(class|interface|enum|record)\\s+([A-Za-z_$][\\w$]*)`
);
// Method/constructor with a body: return type is optional (constructors have none); ends with "{".
const METHOD_BLOCK_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_PARAMS}(?:${TYPE_TOKEN}\\s+)?([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)${THROWS_CLAUSE}\\s*\\{`
);
// Abstract/interface method declaration: a return type is REQUIRED; ends with ";".
// Requiring the return type is what separates "void onTick();" from a bare call "doThing();".
const METHOD_ABSTRACT_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_PARAMS}${TYPE_TOKEN}\\s+([A-Za-z_$][\\w$]*)\\s*\\([^)]*\\)${THROWS_CLAUSE}\\s*;`
);
const FIELD_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_TOKEN}\\s+([A-Za-z_$][\\w$]*)\\s*(?:=|;|,)`
);

// Lines that begin with one of these keywords are statements, not declarations. They are
// skipped wholesale so that "return helper();" / "for (...)" / "new Foo() {" never produce
// phantom members. "default"/"synchronized" are intentionally excluded (they double as
// member modifiers); the method regexes reject their statement forms structurally.
const STATEMENT_LINE_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "else", "do",
  "case", "break", "continue", "assert", "super", "this", "try", "new", "yield"
]);
// Defence-in-depth: even if a keyword is captured as a member name, drop it.
const NOISE_TOKENS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw"]);

function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function isNoiseToken(token: string): boolean {
  return NOISE_TOKENS.has(token);
}

function isStatementLine(line: string): boolean {
  const firstWord = /^([A-Za-z_$][\w$]*)/.exec(line)?.[1];
  return firstWord != null && STATEMENT_LINE_KEYWORDS.has(firstWord);
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
    const normalized = normalizeLine(rawLine);
    if (!normalized) {
      continue;
    }
    // Drop a single leading "}"/"{" so "} public void foo() {" still parses.
    const line = normalized.replace(/^[}{]\s*/, "");
    if (!line || isStatementLine(line)) {
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

    const methodMatch = line.match(METHOD_BLOCK_DECLARATION) ?? line.match(METHOD_ABSTRACT_DECLARATION);
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
