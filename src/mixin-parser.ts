/**
 * Lightweight regex-based parser for Fabric Mixin Java sources.
 * No AST required — pattern-matches annotations and member declarations.
 */

export type ParsedMixinTarget = {
  className: string;
};

export type ParsedInjection = {
  annotation: string;
  method: string;
  line: number;
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
};

export type ParsedAccessor = {
  annotation: "Accessor" | "Invoker";
  name: string;
  targetName: string;
  line: number;
};

export type ParsedMixin = {
  className: string;
  targets: ParsedMixinTarget[];
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

const CLASS_DECL_RE = /^\s*(?:@[\w$.]+(?:\([^)]*\))?\s+)*(?:public\s+|final\s+|abstract\s+|sealed\s+)*\b(?:class|interface)\s+(\w+)/;

// import statements for FQCN resolution
const IMPORT_RE = /^\s*import\s+([\w.]+)\s*;/;

// @Mixin(Foo.class)  or  @Mixin({Foo.class, Bar.class})  or  @Mixin(value = Foo.class)
// Also handles  @Mixin(value = {Foo.class, Bar.class}, priority = 900)
const MIXIN_ANNOTATION_START_RE = /^\s*@Mixin\s*\(/;
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
const METHOD_ATTR_RE = /method\s*=\s*"([^"]+)"/;
const METHOD_ATTR_ARRAY_RE = /method\s*=\s*\{([^}]+)\}/;
const METHOD_ATTR_ITEM_RE = /"([^"]+)"/g;

// @Shadow field / method
const SHADOW_ANNOTATION_RE = /^@Shadow\b/;
// A @Shadow member declared as `<prefix>name` targets `name`; Mixin defaults the prefix
// to "shadow$" and lets `prefix = "..."` override it — including with "", which means
// strip nothing. `aliases` adds fallback names.
const SHADOW_DEFAULT_PREFIX = "shadow$";
const SHADOW_PREFIX_RE = /@Shadow\s*\([^)]*\bprefix\s*=\s*"([^"]*)"/;
const SHADOW_ALIASES_RE = /@Shadow\s*\([^)]*\baliases\s*=\s*(?:\{([^}]+)\}|"([^"]+)")/;
const SHADOW_ALIAS_ITEM_RE = /"([^"]+)"/g;
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
 * Blank out `/* *\/` block comments and `//` line comments (outside string literals)
 * while preserving line count and line numbers, so the annotation scans never match
 * inside commented-out code.
 */
function stripComments(source: string): string {
  let out = "";
  let inBlock = false;
  let inString = false;
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
    if (ch === '"') {
      inString = true;
      out += ch;
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

function parseShadowAliases(annotationText: string): string[] | undefined {
  const aliasesMatch = SHADOW_ALIASES_RE.exec(annotationText);
  if (!aliasesMatch) {
    return undefined;
  }
  const arrayContent = aliasesMatch[1]; // {..."..."...} content
  if (!arrayContent) {
    return [aliasesMatch[2]];
  }
  const aliases: string[] = [];
  SHADOW_ALIAS_ITEM_RE.lastIndex = 0;
  let itemMatch: RegExpExecArray | null;
  while ((itemMatch = SHADOW_ALIAS_ITEM_RE.exec(arrayContent)) !== null) {
    aliases.push(itemMatch[1]);
  }
  return aliases.length > 0 ? aliases : undefined;
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
  const parseWarnings: string[] = [];
  const targets: ParsedMixinTarget[] = [];
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

  // --- Pass 1: find @Mixin annotation and class name ---
  let i = 0;
  while (i < lines.length) {
    if (MIXIN_ANNOTATION_START_RE.test(lines[i])) {
      const { text: mixinText, endIndex } = collectMultilineAnnotation(lines, i);
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
      for (const targetName of annotationTargets) {
        if (!targets.some((entry) => entry.className === targetName)) {
          targets.push({ className: targetName });
        }
      }
      const priorityMatch = MIXIN_PRIORITY_RE.exec(mixinText);
      if (priorityMatch) {
        priority = parseInt(priorityMatch[1], 10);
      }
      i = endIndex + 1;
      continue;
    }

    const classMatch = CLASS_DECL_RE.exec(lines[i]);
    if (classMatch && !className) {
      className = classMatch[1];
    }
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
      const { text: collected, endIndex } = collectMultilineAnnotation(lines, i);
      // Read the attributes from this annotation's own span; a preceding annotation on the
      // same line may carry a `method` attribute of its own.
      const fullAnnotation = collected.slice(injMatched.offset);
      const methodMatch = METHOD_ATTR_RE.exec(fullAnnotation);
      if (methodMatch) {
        injections.push({ annotation, method: methodMatch[1], line: lineNum });
      } else {
        // Try array form: method = {"m1", "m2"}
        const arrayMatch = METHOD_ATTR_ARRAY_RE.exec(fullAnnotation);
        if (arrayMatch) {
          const inner = arrayMatch[1];
          METHOD_ATTR_ITEM_RE.lastIndex = 0;
          let itemMatch: RegExpExecArray | null;
          let found = false;
          while ((itemMatch = METHOD_ATTR_ITEM_RE.exec(inner)) !== null) {
            injections.push({ annotation, method: itemMatch[1], line: lineNum });
            found = true;
          }
          if (!found) {
            parseWarnings.push(`Line ${lineNum}: @${annotation} method array is empty.`);
          }
        } else {
          parseWarnings.push(`Line ${lineNum}: @${annotation} missing method attribute.`);
        }
      }
      i = endIndex + 1;
      continue;
    }

    // --- @Shadow ---
    const shadowMatched = matchLineAnnotation(line, SHADOW_ANNOTATION_RE);
    if (shadowMatched) {
      const shadowText = line.slice(shadowMatched.offset);
      // An explicit `prefix = ""` means strip nothing, so absent and empty must stay apart.
      const prefixMatch = SHADOW_PREFIX_RE.exec(shadowText);
      const prefix = prefixMatch ? prefixMatch[1] : SHADOW_DEFAULT_PREFIX;
      const aliases = parseShadowAliases(shadowText);
      // Try same-line declaration first (e.g. `@Shadow @Final private int x;`)
      const inlineDecl = stripInlineAnnotations(line);
      const inlineMethodMatch = inlineDecl.includes("(") ? METHOD_DECL_RE.exec(inlineDecl) : null;
      const inlineFieldMatch = !inlineMethodMatch ? FIELD_DECL_RE.exec(inlineDecl) : null;
      if (inlineMethodMatch) {
        shadows.push(makeShadow("method", inlineMethodMatch[2], lineNum, prefix, aliases));
        i++;
        continue;
      } else if (inlineFieldMatch) {
        shadows.push(makeShadow("field", inlineFieldMatch[2], lineNum, prefix, aliases));
        i++;
        continue;
      }
      // Advance past @Shadow line to find the declaration
      let declLine = i + 1;
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
        const { text: collected, endIndex } = collectMultilineAnnotation(lines, i);
        // Read from this annotation's own "@" so a string argument of a preceding
        // annotation on the same line is not mistaken for the explicit target.
        const explicitMatch = ACCESSOR_EXPLICIT_RE.exec(collected.slice(accessorStartMatched.offset));
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

  return {
    className,
    targets,
    priority,
    imports,
    injections,
    shadows,
    accessors,
    parseWarnings
  };
}
