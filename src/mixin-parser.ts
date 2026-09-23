/**
 * Lightweight regex-based parser for Fabric Mixin Java sources.
 * No AST required — pattern-matches annotations and member declarations.
 */

export type ParsedMixinTarget = {
  className: string;
};

/**
 * One `@Mixin`-annotated class in the file. A file can hold several (nested or top-level),
 * and each member is validated only against the targets of the class that owns it.
 */
export type ParsedMixinClass = {
  /** Simple name of the annotated class. */
  className: string;
  /** Targets named by this class's own `@Mixin` annotation. */
  targets: ParsedMixinTarget[];
  /** 1-based line of the `@Mixin` annotation. */
  startLine: number;
  /** 1-based line of the brace that closes the class body. */
  endLine: number;
};

export type ParsedInjection = {
  annotation: string;
  method: string;
  line: number;
  /**
   * Index into `ParsedMixin.mixins` of the innermost `@Mixin` class enclosing this member
   * (a member of a nested non-mixin class belongs to the nearest enclosing `@Mixin` class).
   * Absent when no `@Mixin` class encloses it; such a member is checked against every target.
   */
  mixinIndex?: number;
};

export type ParsedShadow = {
  kind: "field" | "method";
  name: string;
  /**
   * The member looked up in the target: for a method, the declared name with the @Shadow
   * prefix removed; for a field, the declared name unchanged (fields are not prefixed).
   */
  targetName?: string;
  /** Alternative target names from `@Shadow(aliases = {...})`. */
  aliases?: string[];
  descriptor?: string;
  line: number;
  /** Owning `@Mixin` class; see `ParsedInjection.mixinIndex`. */
  mixinIndex?: number;
};

export type ParsedAccessor = {
  annotation: "Accessor" | "Invoker";
  name: string;
  targetName: string;
  line: number;
  /** Owning `@Mixin` class; see `ParsedInjection.mixinIndex`. */
  mixinIndex?: number;
};

export type ParsedMixin = {
  className: string;
  /** Every target named by any `@Mixin` annotation in the file, first occurrence first. */
  targets: ParsedMixinTarget[];
  /**
   * Each `@Mixin` class whose body could be located, in source order. Absent on a parse
   * result built without ownership, whose members are then checked against every target.
   */
  mixins?: ParsedMixinClass[];
  priority?: number;
  imports: Map<string, string>;
  injections: ParsedInjection[];
  shadows: ParsedShadow[];
  accessors: ParsedAccessor[];
  parseWarnings: string[];
};

/* ------------------------------------------------------------------ */
/*  Regex patterns                                                     */
/* ------------------------------------------------------------------ */

// A type declaration keyword and its name; `.class` literals and `@interface` are not declarations.
const TYPE_DECL_RE = /(?<![\w$.@])(?:class|interface|enum|record)\s+([\w$]+)/;
const CLASS_DECL_RE = /^\s*(?:@[\w$.]+(?:\([^)]*\))?\s+)*(?:public\s+|final\s+|abstract\s+|sealed\s+)*\b(?:class|interface)\s+(\w+)/;

// import statements for FQCN resolution
const IMPORT_RE = /^\s*import\s+([\w.]+)\s*;/;

// @Mixin(Foo.class)  or  @Mixin({Foo.class, Bar.class})  or  @Mixin(value = Foo.class)
// Also handles  @Mixin(value = {Foo.class, Bar.class}, priority = 900)
const MIXIN_ANNOTATION_START_RE = /^\s*@Mixin\s*\(/;
// A @Mixin annotation anywhere on a line; matched against comment- and literal-free text.
const MIXIN_ANNOTATION_ANYWHERE_RE = /@Mixin\s*\(/g;
// `$` is a legal Java identifier character (e.g. generated classes like My$Class);
// without it the capture would start mid-name and yield a wrong target.
const MIXIN_TARGET_RE = /([\w$][\w.$]*?)\.class/g;
const MIXIN_PRIORITY_RE = /priority\s*=\s*(\d+)/;

// String-form targets: @Mixin(targets = "pkg.Class") or @Mixin(targets = {"pkg.A", "pkg.B"})
const MIXIN_TARGETS_STRING_RE = /targets\s*=\s*(?:\{([^}]+)\}|"([^"]+)")/;
const MIXIN_TARGETS_STRING_ITEM_RE = /"([^"]+)"/g;

// Injection annotations: @Inject, @Redirect, @ModifyArg, @ModifyVariable, @ModifyConstant, @ModifyExpressionValue
// Also MixinExtras: @WrapOperation, @WrapWithCondition, @ModifyReturnValue
// Matched at an annotation boundary found by annotationStarts(), so an annotation that is
// not the first token on its line is still recognised.
const INJECTION_ANNOTATION_RE =
  /^@(Inject|Redirect|ModifyArg|ModifyVariable|ModifyConstant|ModifyExpressionValue|WrapOperation|WrapWithCondition|ModifyReturnValue)\s*\(/;

// @Shadow field / method
const SHADOW_ANNOTATION_RE = /^@Shadow\b/;
// A @Shadow member declared as `<prefix>name` targets `name`; Mixin defaults the prefix
// to "shadow$" and lets `prefix = "..."` override it — including with "", which means
// strip nothing. `aliases` adds fallback names.
const SHADOW_DEFAULT_PREFIX = "shadow$";
const FIELD_DECL_RE =
  /(?:private|protected|public)?\s*(?:static\s+)?(?:final\s+)?(?:volatile\s+)?([\w.][\w<>,.\s?\[\]]*?)\s+([\w$]+)\s*[;=]/;
const METHOD_DECL_RE =
  /(?:private|protected|public)?\s*(?:default\s+)?(?:static\s+)?(?:synchronized\s+)?(?:abstract\s+)?(?:native\s+)?(?:<[\w<>,.\s?&\[\]]+>\s+)?([\w.][\w<>,.\s?\[\]]*?)\s+([\w$]+)\s*\(/;

// @Accessor / @Invoker
const ACCESSOR_ANNOTATION_RE = /^@(Accessor|Invoker)\s*(?:\(\s*\)|\(\s*(?:value\s*=\s*)?"([^"]+)"\s*(?:,\s*\w+\s*=\s*(?:\w+|"[^"]*")\s*)*\))?(?:\s|$)/;
const ACCESSOR_ANNOTATION_START_RE = /^@(Accessor|Invoker)\s*\(/;
const ACCESSOR_EXPLICIT_RE = /"([^"]+)"/;

// Naming conventions for accessor/invoker target inference
const GETTER_PREFIX_RE = /^(?:get|is)([A-Z].*)/;
const SETTER_PREFIX_RE = /^set([A-Z].*)/;
const INVOKER_PREFIX_RE = /^(?:invoke|call)([A-Z].*)/;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function collectMultilineAnnotation(lines: string[], startIndex: number): { text: string; endIndex: number } {
  let depth = 0;
  let text = "";
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    text += (i === startIndex ? "" : "\n") + line;
    for (const ch of line) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
    }
    if (depth <= 0) {
      return { text, endIndex: i };
    }
  }
  return { text, endIndex: lines.length - 1 };
}

/**
 * Blank out `/* *\/` block comments and `//` line comments (outside string and char
 * literals) while preserving line count and line numbers, so the annotation scans never
 * match inside commented-out code. A Java text block (`"""..."""`) spans lines, so its
 * body is blanked too, behind an empty `""` literal: the line-based scans would otherwise
 * read annotation-shaped text inside it as live code.
 */
function stripComments(source: string): string {
  let out = "";
  let inBlock = false;
  let inString = false;
  let inTextBlock = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (inBlock) {
      if (ch === "*" && next === "/") {
        out += "  ";
        i++;
        inBlock = false;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inTextBlock) {
      if (ch === "\\" && next !== undefined) {
        // An escape (including `\"""`) never closes the block; `\<newline>` keeps its line.
        out += next === "\n" ? " \n" : "  ";
        i++;
      } else if (ch === '"' && next === '"' && source[i + 2] === '"') {
        out += "   ";
        i += 2;
        inTextBlock = false;
      } else {
        out += ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"' && next === '"' && source[i + 2] === '"') {
      out += '"" ';
      i += 2;
      inTextBlock = true;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "'") {
      // Copy a char literal through its closing quote, so '"' does not open a string.
      out += ch;
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\" && i + 1 < source.length && source[i + 1] !== "\n") {
          out += source[i] + source[i + 1];
          i += 2;
          continue;
        }
        out += source[i];
        i++;
      }
      if (source[i] === "'") {
        out += "'";
      } else {
        i--; // unterminated on this line: let the newline be handled normally
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      out += "  ";
      i++;
      inBlock = true;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        i++;
      }
      i--;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * `line` with the contents of its string and char literals blanked and its quotes kept, so a
 * brace, parenthesis or keyword inside a literal is never read as code. Positions are kept.
 * Applied to `stripComments` output, where no literal spans a line.
 */
function blankLiterals(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    out += ch;
    if (ch !== '"' && ch !== "'") {
      continue;
    }
    i++;
    while (i < line.length && line[i] !== ch) {
      const width = line[i] === "\\" && i + 1 < line.length ? 2 : 1;
      out += " ".repeat(width);
      i += width;
    }
    if (i < line.length) {
      out += ch;
    }
  }
  return out;
}

/**
 * The class decorated by the annotation whose `@` sits at `codeLines[startIndex][offset]`:
 * its simple name and the 0-based line of the brace closing its body, found by skipping the
 * annotation's argument list, then the declaration keyword, then balancing braces. `codeLines`
 * carry no comments or literal contents, so only code braces count. Null when no class body
 * follows the annotation.
 */
function findAnnotatedClassBody(
  codeLines: string[],
  startIndex: number,
  offset: number
): { className: string; endIndex: number } | null {
  let lineIndex = startIndex;
  let col = offset;
  let depth = 0;
  let argsClosed = false;
  argsScan: for (; lineIndex < codeLines.length; lineIndex++, col = 0) {
    const text = codeLines[lineIndex];
    for (; col < text.length; col++) {
      if (text[col] === "(") {
        depth++;
      } else if (text[col] === ")" && depth > 0) {
        depth--;
        if (depth === 0) {
          col++;
          argsClosed = true;
          break argsScan;
        }
      }
    }
  }
  if (!argsClosed) {
    return null;
  }

  let className: string | undefined;
  for (; lineIndex < codeLines.length; lineIndex++, col = 0) {
    const declMatch = TYPE_DECL_RE.exec(codeLines[lineIndex].slice(col));
    if (declMatch) {
      className = declMatch[1];
      col += declMatch.index + declMatch[0].length;
      break;
    }
  }
  if (className === undefined) {
    return null;
  }

  // The body opens at the first `{` outside the header's parentheses (annotation arguments
  // such as `extends @Mark({1, 2}) Base`) and type-argument brackets.
  let parenDepth = 0;
  let angleDepth = 0;
  let bodyOpen = false;
  headerScan: for (; lineIndex < codeLines.length; lineIndex++, col = 0) {
    const text = codeLines[lineIndex];
    for (; col < text.length; col++) {
      const ch = text[col];
      if (ch === "(") {
        parenDepth++;
      } else if (ch === ")" && parenDepth > 0) {
        parenDepth--;
      } else if (parenDepth === 0 && ch === "<") {
        angleDepth++;
      } else if (parenDepth === 0 && ch === ">" && angleDepth > 0) {
        angleDepth--;
      } else if (parenDepth === 0 && angleDepth === 0 && ch === "{") {
        bodyOpen = true;
        break headerScan;
      }
    }
  }
  if (!bodyOpen) {
    return null;
  }

  depth = 0;
  for (; lineIndex < codeLines.length; lineIndex++, col = 0) {
    const text = codeLines[lineIndex];
    for (; col < text.length; col++) {
      if (text[col] === "{") {
        depth++;
      } else if (text[col] === "}" && depth > 0) {
        depth--;
        if (depth === 0) {
          return { className, endIndex: lineIndex };
        }
      }
    }
  }
  return null;
}

/**
 * Skip past annotations (including multi-line ones) starting at `startIndex`.
 * Returns the index of the first non-annotation line.
 * Lines with inline annotation + declaration (e.g. `@Nullable private int x;`)
 * are treated as declaration lines (not skipped).
 */
function isUpperCaseLetter(ch: string): boolean {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

function skipAnnotations(lines: string[], startIndex: number): number {
  let idx = startIndex;
  while (idx < lines.length) {
    const current = lines[idx];
    // Skip blank lines and comment-only lines that sit between an annotation and the
    // member declaration; otherwise the declaration line is missed and the member dropped.
    if (/^\s*$/.test(current) || /^\s*\/\//.test(current)) {
      idx++;
      continue;
    }
    if (/^\s*\/\*/.test(current)) {
      if (current.includes("*/")) {
        const afterComment = current.slice(current.indexOf("*/") + 2).trim();
        if (afterComment === "") {
          idx++;
          continue;
        }
        break; // declaration text follows an inline block comment
      }
      idx++;
      while (idx < lines.length && !lines[idx].includes("*/")) {
        idx++;
      }
      idx++; // move past the closing "*/" line
      continue;
    }
    if (!/^\s*@/.test(current)) {
      break;
    }
    if (lines[idx].includes("(")) {
      // Check if parentheses are unbalanced (multi-line annotation) — always skip
      let depth = 0;
      for (const ch of lines[idx]) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
      }
      if (depth > 0) {
        // Multi-line annotation — skip to its end
        const { endIndex } = collectMultilineAnnotation(lines, idx);
        idx = endIndex + 1;
        continue;
      }
      // Single-line annotation with parens: check if declaration text remains
      const stripped = stripInlineAnnotations(lines[idx]);
      if (stripped === "") {
        idx++;
      } else {
        break; // declaration with inline annotation
      }
    } else {
      // Simple annotation like `@Final` — check for trailing declaration
      const stripped = lines[idx].replace(/^\s*@[\w$.]+\s*/, "").trim();
      if (stripped === "") {
        idx++;
      } else {
        break; // e.g. `@Deprecated public abstract void foo();`
      }
    }
  }
  return idx;
}

/** Strip inline annotations (e.g. `@Final @Nullable`) from a declaration line. */
const INLINE_ANNOTATION_RE = /\s*@[\w$.]+(?:\([^)]*\))?\s*/g;
function stripInlineAnnotations(line: string): string {
  return line.replace(INLINE_ANNOTATION_RE, " ").trim();
}

/**
 * JavaBeans `Introspector.decapitalize`, which SpongePowered Mixin's AccessorInfo
 * uses for inflection: leave the name unchanged when its first two characters are
 * both upper case (getURL -> URL, getNBT -> NBT), otherwise lower-case the first
 * character (getId -> id, getHealth -> health).
 */
function decapitalize(name: string): string {
  if (name.length === 0) {
    return name;
  }
  if (name.length > 1 && isUpperCaseLetter(name.charAt(1)) && isUpperCaseLetter(name.charAt(0))) {
    return name;
  }
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Index just past the `)` closing the argument list that opens at `open`, or -1 when it
 * does not close on this line. String and char literals (with backslash escapes) are
 * skipped, so a parenthesis inside `@SuppressWarnings("(")` does not shift the balance.
 */
function skipAnnotationArgs(line: string, open: number): number {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < line.length && line[i] !== ch) {
        i += line[i] === "\\" ? 2 : 1;
      }
      if (i >= line.length) {
        return -1; // literal never closes on this line
      }
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/**
 * Offsets of the annotations that open `line`: `@Final @Shadow private int foo;` yields the
 * offsets of `@Final` and `@Shadow`. Argument lists are skipped as a unit, so an annotation
 * name inside a string argument is never reported and nested parentheses do not end the scan
 * early. The scan is line-local: a leading annotation whose argument list does not close on
 * this line ends it, and the annotations behind it are simply not offered.
 */
function annotationStarts(line: string): number[] {
  const starts: number[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) {
    i++;
  }
  while (line[i] === "@") {
    starts.push(i);
    i++;
    while (i < line.length && /[\w$.]/.test(line[i])) {
      i++;
    }
    let next = i;
    while (next < line.length && /\s/.test(line[next])) {
      next++;
    }
    if (line[next] === "(") {
      const close = skipAnnotationArgs(line, next);
      if (close < 0) {
        return starts;
      }
      next = close;
      while (next < line.length && /\s/.test(line[next])) {
        next++;
      }
    }
    i = next;
  }
  return starts;
}

/**
 * Run an annotation pattern against every annotation that opens `line`, so a target
 * annotation preceded by others on the same line is still found. The offset comes back with
 * the match because the annotation's own arguments must be read from there, not from the
 * line start — a preceding `@Meta(method = "other")` would otherwise win.
 */
function matchLineAnnotation(
  line: string,
  pattern: RegExp
): { match: RegExpExecArray; offset: number } | null {
  for (const offset of annotationStarts(line)) {
    const match = pattern.exec(line.slice(offset));
    if (match) {
      return { match, offset };
    }
  }
  return null;
}

/**
 * Argument list of the annotation that opens `annotationText` (the text between its
 * parentheses), or undefined when it has none. String and char literals are skipped while
 * looking for the closing parenthesis; an argument list that never closes yields the rest.
 */
function annotationArguments(annotationText: string): string | undefined {
  const open = /^@[\w$.]+\s*\(/.exec(annotationText);
  if (!open) {
    return undefined;
  }
  const start = open[0].length;
  const close = skipAnnotationArgs(annotationText, start - 1);
  return close < 0 ? annotationText.slice(start) : annotationText.slice(start, close - 1);
}

/**
 * Split `text` at its top-level commas. Commas inside string or char literals, `{...}`
 * arrays and nested `(...)` annotations do not split.
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i++;
      while (i < text.length && text[i] !== ch) {
        i += text[i] === "\\" ? 2 : 1;
      }
      continue;
    }
    if (ch === "(" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "}") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Top-level `name = value` pairs of an annotation argument list, so a selector such as
 * `"tick{2}"` or `"a)b"` stays inside its attribute. A bare value is keyed `value`.
 */
function annotationAttributes(args: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const part of splitTopLevel(args)) {
    const named = /^\s*([\w$]+)\s*=\s*([\s\S]*?)\s*$/.exec(part);
    if (named) {
      attributes.set(named[1], named[2]);
    } else if (part.trim() !== "") {
      attributes.set("value", part.trim());
    }
  }
  return attributes;
}

/** Contents of `text` when it is exactly one string literal (escapes left as written). */
function exactStringLiteral(text: string): string | undefined {
  return /^\s*"((?:[^"\\\n]|\\.)*)"\s*$/.exec(text)?.[1];
}

/**
 * Read an attribute value that is one string literal or an array of them. Anything else —
 * a constant, a concatenation, a method call — cannot be read statically and is counted in
 * `unreadable` (per array element) instead of contributing a string.
 */
function readStringValues(value: string): { isArray: boolean; values: string[]; unreadable: number } {
  const trimmed = value.trim();
  const isArray = trimmed.startsWith("{") && trimmed.endsWith("}");
  const elements = isArray
    ? splitTopLevel(trimmed.slice(1, -1)).filter((element) => element.trim() !== "")
    : [trimmed];
  const values: string[] = [];
  let unreadable = 0;
  for (const element of elements) {
    const literal = exactStringLiteral(element);
    if (literal === undefined) {
      unreadable++;
    } else {
      values.push(literal);
    }
  }
  return { isArray, values, unreadable };
}

/**
 * The annotation that starts at `offset` on `lines[startIndex]`, extended over later lines
 * until its argument list closes; string and char literals are skipped while balancing the
 * parentheses. `close` indexes just past the closing `)` in `text`. An annotation without
 * an argument list, or one whose list never closes, spans only its own line (`close` -1).
 */
function collectAnnotationSpan(
  lines: string[],
  startIndex: number,
  offset: number
): { text: string; endIndex: number; close: number } {
  const first = lines[startIndex].slice(offset);
  const open = /^@[\w$.]+\s*\(/.exec(first);
  if (!open) {
    return { text: first, endIndex: startIndex, close: -1 };
  }
  let text = first;
  let end = startIndex;
  let close = skipAnnotationArgs(text, open[0].length - 1);
  while (close < 0 && end + 1 < lines.length) {
    end++;
    text += "\n" + lines[end];
    close = skipAnnotationArgs(text, open[0].length - 1);
  }
  return close < 0
    ? { text: first, endIndex: startIndex, close: -1 }
    : { text, endIndex: end, close };
}

/**
 * Build a @Shadow entry, resolving the member it targets: for a method, the declared name
 * with the annotation's prefix removed. A name that does not carry the prefix is left alone,
 * and a name that is *only* the prefix would leave nothing to look up, so it stays too.
 * Mixin strips the prefix from methods only (a prefixed field is rejected), so a field
 * keeps its declared name.
 */
function makeShadow(
  kind: "field" | "method",
  name: string,
  line: number,
  prefix: string,
  aliases: string[] | undefined
): ParsedShadow {
  const targetName = kind === "method" && prefix !== "" && name.length > prefix.length && name.startsWith(prefix)
    ? name.slice(prefix.length)
    : name;
  return { kind, name, targetName, aliases, line };
}

function inferAccessorTarget(methodName: string): string {
  const getterMatch = GETTER_PREFIX_RE.exec(methodName);
  if (getterMatch) {
    return decapitalize(getterMatch[1]);
  }
  const setterMatch = SETTER_PREFIX_RE.exec(methodName);
  if (setterMatch) {
    return decapitalize(setterMatch[1]);
  }
  const invokerMatch = INVOKER_PREFIX_RE.exec(methodName);
  if (invokerMatch) {
    return decapitalize(invokerMatch[1]);
  }
  return methodName;
}

/* ------------------------------------------------------------------ */
/*  Main parser                                                        */
/* ------------------------------------------------------------------ */

export function parseMixinSource(source: string): ParsedMixin {
  const lines = stripComments(source).split(/\r?\n/);
  const codeLines = lines.map(blankLiterals);
  const parseWarnings: string[] = [];
  const targets: ParsedMixinTarget[] = [];
  const mixins: ParsedMixinClass[] = [];
  const injections: ParsedInjection[] = [];
  const shadows: ParsedShadow[] = [];
  const accessors: ParsedAccessor[] = [];
  const imports = new Map<string, string>();
  let className = "";
  let priority: number | undefined;

  // --- Pass 0: extract imports ---
  for (const line of lines) {
    const importMatch = IMPORT_RE.exec(line);
    if (importMatch) {
      const fqcn = importMatch[1];
      // Skip wildcard imports (e.g. import java.util.*)
      if (!fqcn.endsWith("*")) {
        const simpleName = fqcn.substring(fqcn.lastIndexOf(".") + 1);
        imports.set(simpleName, fqcn);
      }
    }
  }

  // --- Pass 1: find @Mixin annotations and class name ---
  const recordMixin = (mixinText: string, lineIndex: number, offset: number): void => {
    // `value` (class literals) and `targets` (string names) are both contributed
    // when both are present, so the string form is collected alongside the class
    // literals rather than only as a fallback.
    const annotationTargets: string[] = [];
    MIXIN_TARGET_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MIXIN_TARGET_RE.exec(mixinText)) !== null) {
      annotationTargets.push(match[1]);
    }
    // targets = "..." or targets = {"a", "b"} string form
    const targetsStringMatch = MIXIN_TARGETS_STRING_RE.exec(mixinText);
    if (targetsStringMatch) {
      const arrayContent = targetsStringMatch[1]; // {..."..."...} content
      const singleTarget = targetsStringMatch[2]; // single "..." content
      if (arrayContent) {
        MIXIN_TARGETS_STRING_ITEM_RE.lastIndex = 0;
        let itemMatch: RegExpExecArray | null;
        while ((itemMatch = MIXIN_TARGETS_STRING_ITEM_RE.exec(arrayContent)) !== null) {
          annotationTargets.push(itemMatch[1]);
        }
      } else if (singleTarget) {
        annotationTargets.push(singleTarget);
      }
    }
    const ownTargets: ParsedMixinTarget[] = [];
    for (const targetName of annotationTargets) {
      if (!targets.some((entry) => entry.className === targetName)) {
        targets.push({ className: targetName });
      }
      if (!ownTargets.some((entry) => entry.className === targetName)) {
        ownTargets.push({ className: targetName });
      }
    }
    const body = findAnnotatedClassBody(codeLines, lineIndex, offset);
    if (body) {
      mixins.push({ className: body.className, targets: ownTargets, startLine: lineIndex + 1, endLine: body.endIndex + 1 });
    }
    const priorityMatch = MIXIN_PRIORITY_RE.exec(mixinText);
    if (priorityMatch) {
      priority = parseInt(priorityMatch[1], 10);
    }
  };

  // A @Mixin that opens its line is read with the lines its argument list spans. One that
  // follows other code on its line (`} @Mixin(B.class) abstract class B {`) is found in the
  // comment- and literal-free text and read from its own offset; the rest of the line where
  // its argument list closes is then scanned for another one.
  let i = 0;
  let fromCol = 0;
  while (i < lines.length) {
    if (fromCol === 0 && MIXIN_ANNOTATION_START_RE.test(lines[i])) {
      const { text: mixinText, endIndex } = collectMultilineAnnotation(lines, i);
      recordMixin(mixinText, i, lines[i].indexOf("@"));
      i = endIndex + 1;
      continue;
    }

    if (fromCol === 0) {
      const classMatch = CLASS_DECL_RE.exec(lines[i]);
      if (classMatch && !className) {
        className = classMatch[1];
      }
    }
    MIXIN_ANNOTATION_ANYWHERE_RE.lastIndex = fromCol;
    const inlineMixin = MIXIN_ANNOTATION_ANYWHERE_RE.exec(codeLines[i]);
    if (inlineMixin) {
      const span = collectAnnotationSpan(lines, i, inlineMixin.index);
      if (span.close >= 0) {
        recordMixin(span.text.slice(0, span.close), i, inlineMixin.index);
        fromCol = span.endIndex === i
          ? inlineMixin.index + span.close
          : span.close - (span.text.lastIndexOf("\n") + 1);
        i = span.endIndex;
      } else {
        recordMixin(span.text, i, inlineMixin.index);
        fromCol = 0;
        i++;
      }
      continue;
    }
    fromCol = 0;
    i++;
  }

  if (targets.length === 0) {
    parseWarnings.push("No @Mixin annotation target found.");
  }

  // --- Pass 2: scan member annotations ---
  i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const lineNum = i + 1;

    // --- @Inject / @Redirect / @ModifyArg etc. ---
    const injMatched = matchLineAnnotation(line, INJECTION_ANNOTATION_RE);
    if (injMatched) {
      const annotation = injMatched.match[1];
      // Read the attributes from this annotation's own span; a preceding annotation on the
      // same line may carry a `method` attribute of its own.
      const { text: fullAnnotation, endIndex } = collectAnnotationSpan(lines, i, injMatched.offset);
      const methodValue = annotationAttributes(annotationArguments(fullAnnotation) ?? "").get("method");
      if (methodValue === undefined) {
        parseWarnings.push(`Line ${lineNum}: @${annotation} missing method attribute.`);
      } else {
        const { isArray, values, unreadable } = readStringValues(methodValue);
        const selectors = values.filter((selector) => selector !== "");
        for (const selector of selectors) {
          injections.push({ annotation, method: selector, line: lineNum });
        }
        if (isArray) {
          for (let n = 0; n < unreadable; n++) {
            parseWarnings.push(
              `Line ${lineNum}: @${annotation} could not parse method array element (not a string literal).`
            );
          }
          if (selectors.length === 0 && unreadable === 0) {
            parseWarnings.push(`Line ${lineNum}: @${annotation} method array is empty.`);
          }
        } else if (unreadable > 0) {
          parseWarnings.push(
            `Line ${lineNum}: @${annotation} could not parse method attribute (not a string literal).`
          );
        } else if (selectors.length === 0) {
          parseWarnings.push(`Line ${lineNum}: @${annotation} missing method attribute.`);
        }
      }
      i = endIndex + 1;
      continue;
    }

    // --- @Shadow ---
    const shadowMatched = matchLineAnnotation(line, SHADOW_ANNOTATION_RE);
    if (shadowMatched) {
      let shadowText = line.slice(shadowMatched.offset);
      // Declaration text sharing a line with the annotation (e.g. `@Shadow @Final private
      // int x;`, or `) private int x;` closing a wrapped `@Shadow(` argument list).
      let inlineDecl = stripInlineAnnotations(line);
      let annotationEnd = i;
      // prefix/aliases are read from the whole argument list, even when it wraps.
      const span = collectAnnotationSpan(lines, i, shadowMatched.offset);
      if (span.close >= 0) {
        shadowText = span.text;
        inlineDecl = stripInlineAnnotations(span.text.slice(span.close));
        annotationEnd = span.endIndex;
      }
      // An explicit `prefix = ""` means strip nothing, so absent and empty must stay apart.
      const shadowAttributes = annotationAttributes(annotationArguments(shadowText) ?? "");
      const prefixValue = shadowAttributes.get("prefix");
      const prefix = prefixValue === undefined
        ? SHADOW_DEFAULT_PREFIX
        : exactStringLiteral(prefixValue) ?? SHADOW_DEFAULT_PREFIX;
      const aliasesValue = shadowAttributes.get("aliases");
      const aliasList = aliasesValue === undefined
        ? []
        : readStringValues(aliasesValue).values.filter((alias) => alias !== "");
      const aliases = aliasList.length > 0 ? aliasList : undefined;
      const inlineMethodMatch = inlineDecl.includes("(") ? METHOD_DECL_RE.exec(inlineDecl) : null;
      const inlineFieldMatch = !inlineMethodMatch ? FIELD_DECL_RE.exec(inlineDecl) : null;
      if (inlineMethodMatch) {
        shadows.push(makeShadow("method", inlineMethodMatch[2], lineNum, prefix, aliases));
        i = annotationEnd + 1;
        continue;
      } else if (inlineFieldMatch) {
        shadows.push(makeShadow("field", inlineFieldMatch[2], lineNum, prefix, aliases));
        i = annotationEnd + 1;
        continue;
      }
      // Advance past the @Shadow annotation to find the declaration
      let declLine = annotationEnd + 1;
      // Skip additional annotations between @Shadow and declaration (including multi-line)
      declLine = skipAnnotations(lines, declLine);
      if (declLine < lines.length) {
        const declText = stripInlineAnnotations(lines[declLine]);
        const methodDeclMatch = METHOD_DECL_RE.exec(declText);
        const fieldDeclMatch = FIELD_DECL_RE.exec(declText);
        // Method if it has parentheses
        if (declText.includes("(") && methodDeclMatch) {
          shadows.push(makeShadow("method", methodDeclMatch[2], lineNum, prefix, aliases));
        } else if (fieldDeclMatch) {
          shadows.push(makeShadow("field", fieldDeclMatch[2], lineNum, prefix, aliases));
        } else {
          parseWarnings.push(`Line ${lineNum}: Could not parse @Shadow member declaration.`);
        }
      }
      i = declLine + 1;
      continue;
    }

    // --- @Accessor / @Invoker ---
    const accessorMatched = matchLineAnnotation(line, ACCESSOR_ANNOTATION_RE);
    const accessorStartMatched = !accessorMatched
      ? matchLineAnnotation(line, ACCESSOR_ANNOTATION_START_RE)
      : null;
    if (accessorMatched || accessorStartMatched) {
      const annotation = (accessorMatched?.match[1] ?? accessorStartMatched?.match[1]) as "Accessor" | "Invoker";
      let explicitTarget = accessorMatched?.match[2];

      if (!explicitTarget && accessorStartMatched) {
        // Read from this annotation's own arguments so a string argument of a preceding
        // annotation on the same line is not mistaken for the explicit target.
        const { text: collected, endIndex } = collectAnnotationSpan(lines, i, accessorStartMatched.offset);
        const explicitMatch = ACCESSOR_EXPLICIT_RE.exec(annotationArguments(collected) ?? "");
        if (explicitMatch) {
          explicitTarget = explicitMatch[1];
        }
        i = endIndex;
      }

      // Try same-line declaration first (e.g. `@Accessor("x") int getX();`)
      const inlineDecl = stripInlineAnnotations(line);
      const inlineMethodMatch = inlineDecl.includes("(") ? METHOD_DECL_RE.exec(inlineDecl) : null;
      if (inlineMethodMatch) {
        const methodName = inlineMethodMatch[2];
        const targetName = explicitTarget ?? inferAccessorTarget(methodName);
        accessors.push({ annotation, name: methodName, targetName, line: lineNum });
        i++;
        continue;
      }

      // Find the method declaration following the annotation (skip multi-line annotations)
      let methodLine = i + 1;
      methodLine = skipAnnotations(lines, methodLine);
      if (methodLine < lines.length) {
        const methodDeclMatch = METHOD_DECL_RE.exec(stripInlineAnnotations(lines[methodLine]));
        if (methodDeclMatch) {
          const methodName = methodDeclMatch[2];
          const targetName = explicitTarget ?? inferAccessorTarget(methodName);
          accessors.push({ annotation, name: methodName, targetName, line: lineNum });
        } else {
          parseWarnings.push(`Line ${lineNum}: Could not parse @${annotation} method declaration.`);
        }
      }
      i = methodLine + 1;
      continue;
    }

    i++;
  }

  // Ownership: the innermost @Mixin class whose span holds the member's annotation line.
  // Nested class spans nest, so the containing span that starts last is the innermost.
  const assignOwner = (member: { line: number; mixinIndex?: number }): void => {
    let owner: number | undefined;
    mixins.forEach((mixin, index) => {
      if (
        mixin.startLine <= member.line &&
        member.line <= mixin.endLine &&
        (owner === undefined || mixin.startLine > mixins[owner].startLine)
      ) {
        owner = index;
      }
    });
    if (owner !== undefined) {
      member.mixinIndex = owner;
    }
  };
  injections.forEach(assignOwner);
  shadows.forEach(assignOwner);
  accessors.forEach(assignOwner);

  return {
    className,
    targets,
    mixins,
    priority,
    imports,
    injections,
    shadows,
    accessors,
    parseWarnings
  };
}
