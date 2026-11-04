// Import-boundary rules for workspace packages (backlog B01).
// Kept separate from the tests so negative cases can exercise the checker directly.
//
// This is a pattern-based guard rail, not a sandbox. Each file first goes through a small lexer
// (maskSource) so comments, string contents, template text and regex literals can't cause false
// matches or hide an import. Known gaps, left to code review: property names built at run time
// (`self["fe" + "tch"]`), and source the lexer misreads (a regex literal right after `)`).

import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SCOPE = "@design-loom/";

/** Packages allowed to perform I/O. Everything else is pure logic over supplied data (design doc 02). */
export const MAY_DO_IO: ReadonlySet<string> = new Set(["cli", "integrations"]);

/**
 * Top-level Node built-ins that touch files, the network, processes or threads, load or run code
 * dynamically (`module`, `vm`, `wasi`), or expose machine-specific state that breaks determinism
 * (`os`, `tty`, `v8`). Sub-paths such as `dns/promises` are matched by their top-level name.
 */
const IO_BUILTINS: ReadonlySet<string> = new Set([
  "child_process",
  "cluster",
  "dgram",
  "dns",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "perf_hooks",
  "process",
  "readline",
  "repl",
  "sqlite",
  "tls",
  "tty",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
]);

const BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Globals and helpers that perform I/O, load modules or run code without a static import. */
const IO_GLOBAL_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  // Any bare reference, so aliases such as `const f = fetch` count too. Members (store.fetch) and
  // object keys (`fetch: true`) don't.
  [/(?<![.\w$])(?:fetch|WebSocket|EventSource)\b(?!\s*:)/, "uses a network global"],
  [/(?<![.\w$])globalThis\b/, "reaches the global object"],
  [/\b(?:self|window|global)\s*\.\s*(?:fetch|WebSocket|EventSource|process)\b/, "uses a global through its receiver"],
  [/\bgetBuiltinModule\b/, "loads a built-in through process.getBuiltinModule"],
  [/\bcreateRequire\b/, "creates a require function"],
  [/(?<![.\w$])(?:eval|Function)\s*\(|\bnew\s+Function\b/, "evaluates code from a string"],
];

/**
 * Sources of non-determinism that pure packages must not read (design DL-Q01: same inputs, same
 * outputs). Time, randomness, environment, locale and host details are passed in by cli or integrations.
 */
const NONDETERMINISTIC_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(?<![.\w$])process\b(?!\s*:)/, "reads the process object"],
  [/\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|(?<!\bnew\s+)(?<![.\w$])Date\s*\(/, "reads the current time"],
  [/\bperformance\s*\.\s*now\b/, "reads a timer"],
  [
    /\bMath\s*\.\s*random\b|\b(?:random(?:Bytes|UUID|Int|Fill|FillSync)|getRandomValues|generateKey(?:Pair)?(?:Sync)?|generatePrime(?:Sync)?)\b/,
    "uses randomness",
  ],
  [
    /\.\s*(?:localeCompare|toLocale(?:String|DateString|TimeString|UpperCase|LowerCase))\s*\(|(?<![.\w$])Intl\b/,
    "depends on the host locale",
  ],
];

const REGEX_ALLOWED_AFTER = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_ALLOWED_AFTER_WORD = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);

/**
 * Two views of a source file, both the same length with line breaks kept:
 * - code: comments replaced by spaces;
 * - bare: also the contents of strings, template text and regex literals replaced by spaces.
 * Quotes, backticks and `${ }` stay, so offsets line up and template expressions are still checked.
 */
export function maskSource(source: string): { code: string; bare: string } {
  const code = source.split("");
  const bare = source.split("");
  const n = source.length;
  const blank = (view: string[], at: number): void => {
    if (view[at] !== "\n" && view[at] !== "\r") view[at] = " ";
  };
  const templates: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let last = ""; // last significant character outside comments, strings and regexes
  let lastWord = "";

  const skipQuoted = (start: number, quote: string): number => {
    let i = start + 1;
    while (i < n && source[i] !== quote && source[i] !== "\n") {
      const width = source[i] === "\\" ? 2 : 1;
      for (let k = 0; k < width && i < n; k++, i++) blank(bare, i);
    }
    return i + 1;
  };
  // Scans template text from `start` up to the closing backtick or the next `${`.
  const skipTemplateText = (start: number): number => {
    let i = start;
    while (i < n) {
      if (source[i] === "\\") {
        blank(bare, i);
        blank(bare, i + 1);
        i += 2;
      } else if (source[i] === "`") {
        return i + 1;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        templates.push(depth);
        depth++;
        return i + 2;
      } else {
        blank(bare, i);
        i++;
      }
    }
    return i;
  };
  // Returns the index after the regex literal and its flags, or -1 if the line ends first.
  const skipRegex = (start: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < n) {
      const ch = source[i];
      if (ch === "\n") return -1;
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (!inClass && ch === "/") break;
      if (ch === "[") inClass = true;
      if (ch === "]") inClass = false;
      i++;
    }
    for (let k = start + 1; k < i; k++) blank(bare, k);
    i++;
    while (i < n && /[a-z]/.test(source[i] ?? "")) i++;
    return i;
  };
  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to; k++) {
      blank(code, k);
      blank(bare, k);
    }
  };
  const regexMayStart = (): boolean =>
    last === "" || REGEX_ALLOWED_AFTER.has(last) || REGEX_ALLOWED_AFTER_WORD.has(lastWord);

  let i = 0;
  while (i < n) {
    const ch = source[i] ?? "";
    const next = source[i + 1];
    let operand = false; // whether this token ends an expression (a string, template, regex)
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(i, ch);
      operand = true;
    } else if (ch === "`") {
      i = skipTemplateText(i + 1);
      operand = true;
    } else if (ch === "}" && templates.length > 0 && templates[templates.length - 1] === depth - 1) {
      templates.pop();
      depth--;
      i = skipTemplateText(i + 1);
      operand = true;
    } else if (ch === "/" && regexMayStart() && skipRegex(i) !== -1) {
      i = skipRegex(i);
      operand = true;
    } else if (/[\w$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(source[j] ?? "")) j++;
      lastWord = source.slice(i, j);
      last = "a";
      i = j;
      continue;
    } else {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (!/\s/.test(ch)) {
        last = ch;
        lastWord = "";
      }
      i++;
      continue;
    }
    if (operand) {
      last = "a";
      lastWord = "";
    }
  }
  return { code: code.join(""), bare: bare.join("") };
}

/** import(...) or require(...) calls whose whole first argument isn't one string literal. */
export function hasNonLiteralModuleLoad(source: string): boolean {
  const { bare } = maskSource(source);
  const calls = /(?<![.\w$])(?:import|require)\s*\(/g;
  for (const call of bare.matchAll(calls)) {
    const rest = bare.slice((call.index ?? 0) + call[0].length);
    if (!/^\s*(["'`])[^"'`]*\1\s*[,)]/.test(rest)) return true;
  }
  return false;
}

/** Every module specifier in a source file: static, re-export, side-effect, dynamic and require forms. */
export function findSpecifiers(source: string): string[] {
  const { code, bare } = maskSource(source);
  // Found in the bare view, so comments between tokens are spaces and text inside strings is
  // ignored; the specifier itself is read back from the same offsets in the code view.
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'`])([^"'`]+)\1/dg;
  return [...bare.matchAll(pattern)].map((match) => {
    const [start, end] = match.indices?.[2] ?? [0, 0];
    return code.slice(start, end);
  });
}

export interface FileContext {
  /** Directory name of the package that owns the file, for example "config". */
  packageDir: string;
  /** Absolute path of the package root. Relative imports must stay inside its src folder. */
  packageRoot: string;
  /** Absolute path of the source file. */
  file: string;
  /** Every dependency name declared by the package. */
  declared: ReadonlySet<string>;
}

/** Returns a reason when a specifier breaks a boundary rule, otherwise undefined. */
export function specifierViolation(specifier: string, ctx: FileContext): string | undefined {
  if (specifier.includes("${")) return `non-literal import specifier "${specifier}"`;

  if (specifier.startsWith(".")) {
    // Only src is scanned, so code must come from inside it. JSON data can't import anything,
    // so it may live elsewhere in the package (for example bundled schemas).
    const isData = specifier.endsWith(".json");
    const boundary = isData ? ctx.packageRoot : join(ctx.packageRoot, "src");
    const fromBoundary = relative(boundary, resolve(dirname(ctx.file), specifier));
    // isAbsolute covers Windows paths on another drive, where relative() returns "D:\...".
    if (fromBoundary === ".." || fromBoundary.startsWith(`..${sep}`) || isAbsolute(fromBoundary)) {
      const where = isData ? "package" : "src folder of package";
      return `relative import "${specifier}" leaves the ${where} ${ctx.packageDir}`;
    }
    return undefined;
  }

  if (specifier.startsWith(SCOPE)) {
    const [name = "", ...rest] = specifier.slice(SCOPE.length).split("/");
    if (rest.length > 0) return `deep import "${specifier}"; import the package root instead`;
    if (name === ctx.packageDir) return `package imports itself by name: "${specifier}"`;
    if (!ctx.declared.has(`${SCOPE}${name}`)) return `undeclared workspace dependency "${specifier}"`;
    return undefined;
  }

  const builtin = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier;
  if (BUILTINS.has(builtin) || specifier.startsWith("node:")) {
    const topLevel = builtin.split("/")[0] ?? builtin;
    if (IO_BUILTINS.has(topLevel) && !MAY_DO_IO.has(ctx.packageDir)) {
      return `pure package ${ctx.packageDir} imports I/O module "${specifier}"`;
    }
    return undefined;
  }

  const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
  if (!ctx.declared.has(packageName ?? "")) return `undeclared third-party dependency "${specifier}"`;
  return undefined;
}

/** All boundary violations in one source file. */
export function sourceViolations(source: string, ctx: FileContext): string[] {
  const reasons = findSpecifiers(source)
    .map((specifier) => specifierViolation(specifier, ctx))
    .filter((reason): reason is string => reason !== undefined);
  if (hasNonLiteralModuleLoad(source)) {
    reasons.push(`${ctx.packageDir} loads a module from a non-literal specifier, which can't be checked`);
  }
  if (!MAY_DO_IO.has(ctx.packageDir)) {
    const { bare } = maskSource(source);
    for (const [pattern, description] of [...IO_GLOBAL_PATTERNS, ...NONDETERMINISTIC_PATTERNS]) {
      if (pattern.test(bare)) reasons.push(`pure package ${ctx.packageDir} ${description}`);
    }
  }
  return reasons;
}
