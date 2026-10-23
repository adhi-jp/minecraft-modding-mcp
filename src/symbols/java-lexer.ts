/**
 * Blank out comments, string/char literals and text blocks, returning one output line per
 * input line so line numbers stay valid. A comment becomes a single space and a literal
 * becomes "", which keeps the code's shape (a field initializer still reads `= "";`) while
 * guaranteeing that no brace, parenthesis or semicolon inside a literal or comment is ever
 * seen by a scanner.
 *
 * Most decompiled lines contain no quote or slash; those are returned as-is without being
 * copied character by character, which keeps the whole pass close to a plain line split.
 */
export function stripJavaNoise(lines: readonly string[]): string[] {
  const out: string[] = new Array(lines.length);
  let inBlockComment = false;
  let inTextBlock = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!inBlockComment && !inTextBlock && !/["'/]/.test(line)) {
      out[index] = line;
      continue;
    }

    // Copy runs of plain code with one slice each instead of appending per character.
    let result = "";
    let runStart = 0;
    let at = 0;
    const flush = (end: number): void => {
      if (end > runStart) {
        result += line.slice(runStart, end);
      }
    };

    while (at < line.length) {
      if (inBlockComment) {
        const close = line.indexOf("*/", at);
        if (close < 0) {
          at = line.length;
        } else {
          inBlockComment = false;
          at = close + 2;
        }
        runStart = at;
        continue;
      }
      if (inTextBlock) {
        at = skipTextBlockBody(line, at);
        if (at < 0) {
          at = line.length;
        } else {
          inTextBlock = false;
        }
        runStart = at;
        continue;
      }

      const ch = line[at];
      if (ch === "/" && line[at + 1] === "/") {
        flush(at);
        result += " ";
        runStart = line.length;
        break;
      }
      if (ch === "/" && line[at + 1] === "*") {
        flush(at);
        result += " ";
        inBlockComment = true;
        at += 2;
        runStart = at;
        continue;
      }
      if (ch === "\"" && line[at + 1] === "\"" && line[at + 2] === "\"") {
        flush(at);
        result += "\"\"";
        inTextBlock = true;
        at += 3;
        runStart = at;
        continue;
      }
      if (ch === "\"" || ch === "'") {
        flush(at);
        result += "\"\"";
        at = skipQuoted(line, at + 1, ch);
        runStart = at;
        continue;
      }
      at += 1;
    }
    flush(line.length);
    out[index] = result;
  }

  return out;
}

/** Index just past the closing quote of a "..." or '...' literal; an unterminated one ends the line. */
function skipQuoted(line: string, from: number, quote: string): number {
  let at = from;
  while (at < line.length) {
    const ch = line[at];
    if (ch === "\\") {
      at += 2;
    } else if (ch === quote) {
      return at + 1;
    } else {
      at += 1;
    }
  }
  return line.length;
}

/** Index just past the closing """ of a text block, or -1 when the block continues on the next line. */
function skipTextBlockBody(line: string, from: number): number {
  let at = from;
  while (at < line.length) {
    const ch = line[at];
    if (ch === "\\") {
      at += 2;
    } else if (ch === "\"" && line[at + 1] === "\"" && line[at + 2] === "\"") {
      return at + 3;
    } else {
      at += 1;
    }
  }
  return -1;
}
