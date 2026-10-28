import type { SymbolKind } from "../source-service.js";
import { stripJavaNoise } from "../symbols/java-lexer.js";
import { extractSymbolsFromCode } from "../symbols/symbol-extractor.js";

/** A declaration of a Java source file with the 1-based lines its range starts and ends on. */
export type EnclosingSymbol = {
  symbolKind: SymbolKind;
  symbolName: string;
  startLine: number;
  endLine: number;
};

type ExtractedSymbol = ReturnType<typeof extractSymbolsFromCode>[number];

interface DeclarationScan {
  /** Index of the line the declaration's range ends on. */
  endIndex: number;
  /** Index of the line holding the "{" that opens the body, or -1 when no body opened. */
  bodyIndex: number;
}

// The only characters that change parenthesis depth, open or close a body, or end a declaration.
const STRUCTURAL = /[(){};]/g;

/**
 * Column where the declaration on a symbol line starts: after indentation and one leading
 * "}" or "{", which close or open the surrounding structure, as the extractor reads the line.
 */
function declarationColumn(text: string): number {
  let column = 0;
  while (column < text.length && (text[column] === " " || text[column] === "\t")) {
    column += 1;
  }
  return text[column] === "}" || text[column] === "{" ? column + 1 : column;
}

/**
 * Scan lexed lines from the declaration on line `startIndex`. Before a body opens, only a
 * "{" or ";" outside the parentheses opened since the declaration's start counts, so braces
 * in annotation or call arguments are skipped. A type ends at the brace closing its body; a
 * method at the brace closing its body or at a ";" reached first; a field at the first ";"
 * outside its own braces and parentheses. A range that never ends runs to the last line.
 */
function scanDeclaration(code: readonly string[], startIndex: number, kind: SymbolKind): DeclarationScan {
  const isField = kind === "field";
  const endsAtSemicolon = isField || kind === "method";
  let parenDepth = 0;
  let braceDepth = 0;
  let bodyIndex = -1;
  for (let index = startIndex; index < code.length; index += 1) {
    const text = code[index]!;
    STRUCTURAL.lastIndex = index === startIndex ? declarationColumn(text) : 0;
    for (let match = STRUCTURAL.exec(text); match; match = STRUCTURAL.exec(text)) {
      switch (match[0]) {
        case "(":
          parenDepth += 1;
          break;
        case ")":
          parenDepth -= 1;
          break;
        case "{":
          if (isField || bodyIndex >= 0) {
            braceDepth += 1;
          } else if (parenDepth === 0) {
            braceDepth = 1;
            bodyIndex = index;
          }
          break;
        case "}":
          if (isField || bodyIndex >= 0) {
            braceDepth -= 1;
            if (braceDepth === 0 && bodyIndex >= 0) {
              return { endIndex: index, bodyIndex };
            }
          }
          break;
        case ";":
          if (endsAtSemicolon && parenDepth === 0 && braceDepth === 0) {
            return { endIndex: index, bodyIndex };
          }
          break;
      }
    }
  }
  return { endIndex: code.length - 1, bodyIndex };
}

/**
 * The innermost declaration whose range contains the 1-based `line` of a Java source file:
 * the greatest start line, then the smaller end line, then the first in extractor order.
 * Candidates are the declarations the symbol extractor emits for `content`, except record
 * components, which are `field` rows inside a record header. A declaration's range starts
 * on its own symbol line, so annotation lines above it are outside. Undefined when no
 * declaration contains the line, e.g. on the package line, an import or a header comment.
 */
export function findEnclosingSymbol(filePath: string, content: string, line: number): EnclosingSymbol | undefined {
  const code = stripJavaNoise(content.split(/\r?\n/));
  const symbols = extractSymbolsFromCode(filePath, code);
  // Only a declaration starting at or above the line can contain it. Sorting by descending
  // start line (stable, so extractor order breaks ties) puts inner declarations first.
  const candidates = symbols.filter((symbol) => symbol.line <= line);
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((left, right) => right.line - left.line);

  // A record header runs from the record's line through the line of its body's "{"; the
  // extractor reports the record's components as fields on those lines.
  const recordScans = new Map<ExtractedSymbol, DeclarationScan>();
  const recordHeaders: Array<{ start: number; end: number }> = [];
  for (const symbol of candidates) {
    if (symbol.symbolKind === "record") {
      const scan = scanDeclaration(code, symbol.line - 1, symbol.symbolKind);
      recordScans.set(symbol, scan);
      recordHeaders.push({ start: symbol.line, end: (scan.bodyIndex >= 0 ? scan.bodyIndex : scan.endIndex) + 1 });
    }
  }
  const isRecordComponent = (symbol: ExtractedSymbol): boolean =>
    symbol.symbolKind === "field"
    && recordHeaders.some((header) => symbol.line >= header.start && symbol.line <= header.end);

  let best: { symbol: ExtractedSymbol; endLine: number } | undefined;
  for (const symbol of candidates) {
    if (best && symbol.line < best.symbol.line) {
      break;
    }
    if (isRecordComponent(symbol)) {
      continue;
    }
    const scan = recordScans.get(symbol) ?? scanDeclaration(code, symbol.line - 1, symbol.symbolKind);
    const endLine = scan.endIndex + 1;
    if (endLine >= line && (!best || endLine < best.endLine)) {
      best = { symbol, endLine };
    }
  }
  return best && {
    symbolKind: best.symbol.symbolKind,
    symbolName: best.symbol.symbolName,
    startLine: best.symbol.line,
    endLine: best.endLine
  };
}
