import { sourcePathToFqcn } from "../source/shared-utils.js";
import { stripJavaNoise } from "./java-lexer.js";

interface ExtractedSymbol {
  symbolKind: "class" | "interface" | "enum" | "record" | "method" | "field";
  symbolName: string;
  qualifiedName: string | undefined;
  line: number;
}

// A type token may carry spaced generics (Map<String, Integer>), arrays (int[][]),
// wildcards (List<? extends Foo>), and FQNs (java.util.Map). It must not contain "=".
const TYPE_TOKEN = "[\\w.$][\\w.$<>\\[\\],?\\s]*";
const MODIFIER = "(?:public|private|protected|abstract|final|static|native|synchronized|default|strictfp|transient|volatile|sealed|non-sealed)";
// An annotation may carry one argument list without nested parentheses, e.g. @SuppressWarnings("unused").
const MODIFIER_OR_ANNOTATION_RUN = `(?:(?:@[\\w.]+(?:\\([^()]*\\))?|${MODIFIER})\\s+)*`;
// Type parameters may nest two levels deep: <T extends Comparable<T>>, <K, V extends Map<K, List<V>>>.
const TYPE_PARAMS = "(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)+>\\s*)?";
const THROWS_CLAUSE = "(?:\\s+throws\\s+[\\w.$,\\s]+)?";
// A parameter list may hold one level of nested parentheses, so a parameter annotation with
// arguments (@Named("x") String s, which the lexer turns into @Named("") String s) still matches.
const PARAM_LIST = "\\((?:[^()]|\\([^()]*\\))*\\)";

// "record" is only a contextual keyword: "record instanceof Foo" uses a variable named record.
const CLASS_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}(class|interface|enum|record)\\s+(?!instanceof\\b)([A-Za-z_$][\\w$]*)`
);
// "@interface Foo" opens a type body whose elements are abstract methods, but it is not
// indexed as a type itself.
const ANNOTATION_TYPE_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}@\\s*interface\\s+[A-Za-z_$]`
);
// Method/constructor with a body: return type is optional (constructors have none); ends with "{".
const METHOD_BLOCK_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_PARAMS}(?:${TYPE_TOKEN}\\s+)?([A-Za-z_$][\\w$]*)\\s*${PARAM_LIST}${THROWS_CLAUSE}\\s*\\{`
);
// Abstract/interface method declaration: a return type is REQUIRED; ends with ";".
// Requiring the return type is what separates "void onTick();" from a bare call "doThing();".
const METHOD_ABSTRACT_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_PARAMS}${TYPE_TOKEN}\\s+([A-Za-z_$][\\w$]*)\\s*${PARAM_LIST}${THROWS_CLAUSE}\\s*;`
);
// The start of a method/constructor head that does not complete on its line: the parameter
// list wraps, or "throws" or the "{" follows on a later line.
const METHOD_HEAD = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_PARAMS}(?:${TYPE_TOKEN}\\s+)?([A-Za-z_$][\\w$]*)\\s*\\(`
);
const FIELD_DECLARATION = new RegExp(
  `^${MODIFIER_OR_ANNOTATION_RUN}${TYPE_TOKEN}\\s+([A-Za-z_$][\\w$]*)\\s*(?:=|;|,)`
);

// Annotations anywhere in a declaration carry no member identity. Dropping them before
// matching covers type-use positions the modifier run cannot: Outer.@Nullable Inner,
// <T> @Nullable T, List<@Nullable X>, Foo @Nullable [].
const ANY_ANNOTATION = /@(?!\s*interface\b)[A-Za-z_$][\w$.]*(?:\s*\([^()]*\))?\s*/g;
// Every line CLASS_DECLARATION or ANNOTATION_TYPE_DECLARATION can match contains one of these words.
const TYPE_KEYWORD = /\b(?:class|interface|enum|record)\b/;
// The end of a statement tail just before the "(" of an instance creation, e.g. "new Foo",
// "new a.B<C>", "new @Mark(1) Foo". A "{" right after the ")" that closes such a call opens
// an anonymous class body.
const NEW_CALL_TAIL = /(?<![\w$])new\s+(?:@[\w.]+(?:\s*\([^()]*\))?\s+)*[\w$.]+\s*(?:<[^;{}()]*>)?\s*$/;
// A type header in a statement tail: "class Foo", "static class Inner extends Base", or a
// header split as "public class" / "Foo". "Foo.class" is a class literal, not a header.
const TYPE_HEADER_TAIL = /(?<![\w$.])(?<!\.\s+)(class|interface|enum|record)\s+(?!instanceof\b)[A-Za-z_$][\w$]*[^;{}]*$/;
// How much of a statement tail is kept; a longer one is not a declaration head or "new" call.
const MAX_TAIL_CHARS = 512;
// A wrapped declaration head longer than this is not a declaration worth joining.
const MAX_HEAD_LINES = 64;

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

/**
 * One open "{". Members are declared directly inside a "type" body (class, interface, enum,
 * record, @interface) or an "anon" body (anonymous class, enum constant body); a "block" is
 * any other brace: method, constructor, initializer, lambda, control statement or array
 * initializer. Its contents are statements and locals, never members.
 */
interface BraceFrame {
  kind: "type" | "anon" | "block";
  // Parenthesis depth at which the "{" opened. A member declaration sits at exactly this
  // depth; anything deeper is inside an argument list, e.g. a lambda passed to a call.
  parenDepth: number;
  isEnum: boolean;
  // An enum body starts with its constants; members can follow only after the first ";".
  inEnumConstants: boolean;
}

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

function withoutAnnotations(text: string): string {
  return text.includes("@") ? text.replace(ANY_ANNOTATION, "").trim() : text;
}

function matchMethodDeclaration(text: string): RegExpMatchArray | null {
  return text.match(METHOD_BLOCK_DECLARATION) ?? text.match(METHOD_ABSTRACT_DECLARATION);
}

function lastSignificantChar(text: string, end = text.length): string | undefined {
  for (let at = end - 1; at >= 0; at -= 1) {
    const ch = text[at]!;
    if (ch !== " " && ch !== "\t") {
      return ch;
    }
  }
  return undefined;
}

function lineIndexToLine(lineNo: number): number {
  return lineNo + 1;
}

/**
 * The declaration head that starts at (startIndex, startColumn) of the lexed lines, joined
 * into one whitespace-normalized line through the "{" or ";" that follows its parameter list,
 * with the index of the line that "{" or ";" is on. Undefined when the text is not such a
 * head: a "{", "}" or ";" outside parentheses comes first, or the head runs past MAX_HEAD_LINES.
 */
function joinWrappedHead(
  code: readonly string[],
  startIndex: number,
  startColumn: number
): { text: string; endIndex: number } | undefined {
  const parts: string[] = [];
  let parenDepth = 0;
  let listClosed = false;
  const endIndex = Math.min(code.length, startIndex + MAX_HEAD_LINES);
  for (let index = startIndex; index < endIndex; index += 1) {
    const text = code[index] ?? "";
    const from = index === startIndex ? startColumn : 0;
    for (let at = from; at < text.length; at += 1) {
      const ch = text[at];
      if (ch === "(") {
        parenDepth += 1;
      } else if (ch === ")") {
        parenDepth -= 1;
        listClosed ||= parenDepth === 0;
      } else if (parenDepth === 0 && (ch === "{" || ch === ";" || ch === "}")) {
        if (!listClosed || ch === "}") {
          return undefined;
        }
        parts.push(text.slice(from, at + 1));
        return { text: normalizeLine(parts.join(" ")), endIndex: index };
      }
    }
    parts.push(text.slice(from));
  }
  return undefined;
}

/**
 * Components of the record header whose "(" follows (startIndex, startColumn) of the lexed
 * lines. Each component is named by its last identifier outside type arguments and nested
 * parentheses (annotation arguments), and placed on the line where that identifier is.
 */
function recordComponents(
  code: readonly string[],
  startIndex: number,
  startColumn: number
): Array<{ name: string; index: number }> {
  const components: Array<{ name: string; index: number }> = [];
  let parenDepth = 0;
  let angleDepth = 0;
  let last: { name: string; index: number } | undefined;
  // One word (identifier or number) or one other character per match.
  const token = /[\w$]+|[^\w$]/gy;
  const endIndex = Math.min(code.length, startIndex + MAX_HEAD_LINES);
  for (let index = startIndex; index < endIndex; index += 1) {
    const text = code[index] ?? "";
    token.lastIndex = index === startIndex ? startColumn : 0;
    for (let match = token.exec(text); match; match = token.exec(text)) {
      const value = match[0];
      if (/^[\w$]/.test(value)) {
        if (parenDepth === 1 && angleDepth === 0 && /^[A-Za-z_$]/.test(value)) {
          last = { name: value, index };
        }
      } else if (parenDepth === 0) {
        // Before the component list: skip the type parameters, whose annotations may carry
        // their own argument lists (record Box<@Tag(id = 1) T>(T value)).
        if (value === "<") {
          angleDepth += 1;
        } else if (value === ">") {
          angleDepth -= 1;
        } else if (angleDepth === 0 && value === "(") {
          parenDepth = 1;
        } else if (angleDepth === 0 && value === "{") {
          return components;
        }
      } else if (value === "(") {
        parenDepth += 1;
      } else if (value === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          if (last) components.push(last);
          return components;
        }
      } else if (parenDepth === 1 && value === "<") {
        angleDepth += 1;
      } else if (parenDepth === 1 && value === ">") {
        angleDepth -= 1;
      } else if (parenDepth === 1 && angleDepth === 0 && value === ",") {
        if (last) components.push(last);
        last = undefined;
      }
    }
  }
  return components;
}

export function extractSymbolsFromSource(filePath: string, content: string): Array<ExtractedSymbol> {
  const lines = content.split(/\r?\n/);
  // Comments and literals are blanked first, so a brace, parenthesis or declaration inside
  // them can neither shift the scope below nor be emitted.
  const code = stripJavaNoise(lines);
  const symbols: ExtractedSymbol[] = [];
  const qualifiedName = sourcePathToFqcn(filePath);

  // Scope state. Methods and fields are emitted only in member position: directly inside a
  // type or anonymous-class body, outside any parentheses. That is what keeps parameters of
  // a wrapped parameter list and the locals of method bodies, lambdas and initializers out.
  const frames: BraceFrame[] = [];
  // One entry per open "(", true when it opens an instance creation "new Foo(".
  const openParens: boolean[] = [];
  let lastCloseWasNewCall = false;
  // A type header seen but whose body "{" has not been reached yet; headers may wrap.
  let pendingType: { isEnum: boolean; parenDepth: number } | undefined;
  // Carried from the previous code line for a "{" that starts a line.
  let previousSignificant: string | undefined;
  // The statement tail: code since the last ";", "{" or "}". Lines before the current one
  // are carried in carriedTail (joined with a space); on the current line the tail starts
  // after lineBoundary, or at the start of the line when it holds no boundary yet.
  let carriedTail = "";
  let lineBoundary = -1;
  // The last line of a wrapped declaration head already emitted. Its continuation lines can
  // sit in member position ("throws A, B {" after a closed parameter list) but declare nothing.
  let headEndIndex = -1;

  const statementTail = (text: string, at: number): string =>
    lineBoundary >= 0 ? text.slice(lineBoundary + 1, at) : `${carriedTail} ${text.slice(0, at)}`;

  const opensNewCall = (text: string, at: number): boolean => {
    // Most "(" have no "new" earlier in their statement; skip building the tail for them.
    if (text.lastIndexOf("new", at) <= lineBoundary && (lineBoundary >= 0 || !carriedTail.includes("new"))) {
      return false;
    }
    return NEW_CALL_TAIL.test(statementTail(text, at));
  };

  const inMemberPosition = (): boolean => {
    const top = frames.at(-1);
    return top !== undefined
      && top.kind !== "block"
      && top.parenDepth === openParens.length
      && !top.inEnumConstants;
  };

  const openBrace = (text: string, at: number): void => {
    const parenDepth = openParens.length;
    const top = frames.at(-1);
    let kind: BraceFrame["kind"] = "block";
    let isEnum = false;
    if (pendingType && pendingType.parenDepth === parenDepth) {
      kind = "type";
      isEnum = pendingType.isEnum;
      pendingType = undefined;
    } else if (lastCloseWasNewCall && (lastSignificantChar(text, at) ?? previousSignificant) === ")") {
      kind = "anon";
    } else if (top?.inEnumConstants && top.parenDepth === parenDepth) {
      // FOO("x") { ... }: the body of an enum constant.
      kind = "anon";
    } else if (inMemberPosition()) {
      // A type header the line-start match missed, e.g. "class Outer { static class Inner {"
      // or a header split before its name. Its members still need a type frame; the type
      // itself is not emitted.
      const header = TYPE_HEADER_TAIL.exec(statementTail(text, at));
      if (header) {
        kind = "type";
        isEnum = header[1] === "enum";
      }
    }
    frames.push({ kind, parenDepth, isEnum, inEnumConstants: isEnum });
  };

  // Advance the scope state over text[from, to). Jumping between structural characters with
  // a regex is markedly faster than visiting every character of the file.
  const structural = /[(){};]/g;
  const scan = (text: string, from: number, to: number): void => {
    structural.lastIndex = from;
    for (let match = structural.exec(text); match && match.index < to; match = structural.exec(text)) {
      const at = match.index;
      switch (match[0]) {
        case "(":
          openParens.push(opensNewCall(text, at));
          break;
        case ")":
          lastCloseWasNewCall = openParens.pop() ?? false;
          break;
        case "{":
          openBrace(text, at);
          lineBoundary = at;
          break;
        case "}":
          frames.pop();
          lineBoundary = at;
          break;
        case ";": {
          lineBoundary = at;
          const top = frames.at(-1);
          if (top?.inEnumConstants && top.parenDepth === openParens.length) {
            top.inEnumConstants = false;
          }
          if (pendingType && pendingType.parenDepth === openParens.length) {
            pendingType = undefined;
          }
          break;
        }
      }
    }
  };

  const push = (symbolKind: ExtractedSymbol["symbolKind"], symbolName: string | undefined, index: number): void => {
    if (symbolName && !isNoiseToken(symbolName)) {
      symbols.push({ symbolKind, symbolName, qualifiedName, line: lineIndexToLine(index) });
    }
  };

  for (let index = 0; index < code.length; index += 1) {
    const text = code[index] ?? "";
    // Drop a single leading "}"/"{" so "} public void foo() {" still parses, but let the
    // scope state see it first.
    let column = 0;
    while (column < text.length && (text[column] === " " || text[column] === "\t")) {
      column += 1;
    }
    if (text[column] === "}" || text[column] === "{") {
      scan(text, column, column + 1);
      column += 1;
    }
    const memberPosition = index > headEndIndex && inMemberPosition();
    // Outside member position only a type declaration can be emitted. Most such lines are
    // statements in method bodies, so they are skipped before normalizing unless a type
    // keyword occurs on them.
    const line = memberPosition || TYPE_KEYWORD.test(text) ? normalizeLine(text.slice(column)) : "";

    if (line && !isStatementLine(line)) {
      const classMatch = line.match(CLASS_DECLARATION);
      if (classMatch) {
        // Types are emitted at any depth, including local and anonymous-body types.
        const symbolKind = classMatch[1] as ExtractedSymbol["symbolKind"];
        const symbolName = classMatch[2]!;
        push(symbolKind, symbolName, index);
        pendingType = { isEnum: symbolKind === "enum", parenDepth: openParens.length };
        if (symbolKind === "record") {
          // Start after "record Name", so the argument list of a leading annotation is not
          // read as the record header. "$" is legal in the name and must not act as an anchor.
          const nameAt = text.slice(column).search(
            new RegExp(`\\brecord\\s+${symbolName.replaceAll("$", "\\$")}(?![\\w$])`)
          );
          for (const component of recordComponents(code, index, column + Math.max(0, nameAt))) {
            push("field", component.name, component.index);
          }
        }
      } else if (ANNOTATION_TYPE_DECLARATION.test(line)) {
        pendingType = { isEnum: false, parenDepth: openParens.length };
      } else if (memberPosition) {
        const target = withoutAnnotations(line);
        let methodMatch = matchMethodDeclaration(target);
        if (!methodMatch && METHOD_HEAD.test(target)) {
          const head = joinWrappedHead(code, index, column);
          if (head) {
            methodMatch = matchMethodDeclaration(withoutAnnotations(head.text));
            if (methodMatch) {
              headEndIndex = head.endIndex;
            }
          }
        }
        if (methodMatch) {
          push("method", methodMatch[1], index);
        } else {
          push("field", target.match(FIELD_DECLARATION)?.[1], index);
        }
      }
    }

    scan(text, column, text.length);
    previousSignificant = lastSignificantChar(text) ?? previousSignificant;
    // Carry trimmed code only, so blank lines and indentation do not use up the cap.
    const carried = (lineBoundary >= 0 ? text.slice(lineBoundary + 1) : text).trim();
    if (lineBoundary >= 0 || !carriedTail) {
      carriedTail = carried;
    } else if (carried) {
      carriedTail = `${carriedTail} ${carried}`;
    }
    if (carriedTail.length > MAX_TAIL_CHARS) {
      carriedTail = carriedTail.slice(-MAX_TAIL_CHARS);
    }
    lineBoundary = -1;
  }

  return symbols;
}
