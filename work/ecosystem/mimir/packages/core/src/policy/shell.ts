/** Placeholder left in a word where a command substitution stood. */
export const SUBSTITUTION_PLACEHOLDER = "$(…)";

/** A word after quote removal. */
export interface ShellWord {
  text: string;
  /**
   * True when the shell would change this word before running it in a way we cannot resolve
   * statically: parameter expansion (`$X`, `${X}`), command substitution, arithmetic expansion,
   * or an unquoted glob (`*`, `?`, `[..]`) or brace (`{a,b}`) pattern.
   */
  unresolved: boolean;
}

/**
 * A redirection kept for checking. `op` is one of `>`, `>>`, `>|`, `<>`, `&>`, `&>>` (writes),
 * `<` (read) or `<<<` (here-string; `target` is data, not a path). File-descriptor
 * duplication (`2>&1`, `<&0`, `>&-`) and here-documents are not recorded.
 */
export interface Redirect {
  op: string;
  target: ShellWord;
}

export interface SimpleCommand {
  words: ShellWord[];
  redirects: Redirect[];
}

/**
 * The commands a script line runs, in order. Commands from substitutions follow the command
 * that contains them. When `opaque` is set, the line uses a construct the parser does not model
 * and `commands` must not be trusted: the classifier treats the whole line as unclassifiable.
 */
export interface Script {
  commands: SimpleCommand[];
  opaque?: string;
}

/** Standalone words that look like glob/brace syntax but are shell syntax or `test`. */
const GLOB_EXEMPT = new Set(["[", "]", "[[", "]]", "{", "}", "{}"]);
const SIMPLE_PARAM = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])$/;
const MAX_PARSE_DEPTH = 16;

class Opaque extends Error {}

function opaque(reason: string): never {
  throw new Opaque(reason);
}

/** Split a shell string into simple commands (argv strings). Ignores `opaque`; see `parseScript`. */
export function parseShell(src: string): string[][] {
  return parseScript(src).commands.map((c) => c.words.map((w) => w.text));
}

/** Like `parseShell` but keeps per-word resolution flags. */
export function parseShellWords(src: string): ShellWord[][] {
  return parseScript(src).commands.map((c) => c.words);
}

/**
 * Parse a POSIX-ish shell string. Pure and **fail-closed**: anything it does not fully model sets
 * `opaque` (arithmetic commands `(( ))`, `$[ ]`, non-trivial `${...}` expansions, process
 * substitution, unusual redirections, named-fd redirections, unterminated quotes, substitutions or
 * here-documents, `case` or here-documents inside `$( )`).
 *
 * Modelled: quotes and escapes (including `$'...'` ANSI-C decoding), `; & && | || |&`, newlines,
 * `( )` subshells, `$( )` and backtick substitutions (also in double quotes and in unquoted
 * here-document bodies), numeric `$(( ))`, simple `$X` / `${X}`, redirections (targets kept),
 * here-documents (bodies skipped), comments.
 */
export function parseScript(src: string): Script {
  try {
    return { commands: parse(src, 0) };
  } catch (e) {
    if (e instanceof Opaque) return { commands: [], opaque: e.message };
    throw e;
  }
}

interface Heredoc {
  delim: string;
  quoted: boolean;
  stripTabs: boolean;
}

function parse(src: string, depth: number): SimpleCommand[] {
  if (depth > MAX_PARSE_DEPTH) opaque("nesting too deep");
  const commands: SimpleCommand[] = [];
  const pendingSubs: SimpleCommand[] = [];
  const heredocs: Heredoc[] = [];
  let cur: SimpleCommand = { words: [], redirects: [] };
  let text = "";
  let inWord = false;
  let quoted = false;
  let dynamic = false;
  let glob = false;
  let pendingRedirect: string | undefined;
  let pendingHeredoc: { stripTabs: boolean } | undefined;
  let i = 0;

  const endWord = () => {
    if (inWord) {
      const w: ShellWord = { text, unresolved: dynamic || (glob && !GLOB_EXEMPT.has(text)) };
      if (pendingHeredoc) {
        heredocs.push({ delim: text, quoted, stripTabs: pendingHeredoc.stripTabs });
        pendingHeredoc = undefined;
      } else if (pendingRedirect !== undefined) {
        const op = pendingRedirect;
        pendingRedirect = undefined;
        if (op === ">&" || op === "<&") {
          if (!/^(?:\d+-?|-)$/.test(text)) {
            if (op === "<&") opaque("unknown redirection <&word");
            cur.redirects.push({ op: "&>", target: w });
          }
        } else {
          cur.redirects.push({ op, target: w });
        }
      } else {
        cur.words.push(w);
      }
    }
    text = "";
    inWord = false;
    quoted = false;
    dynamic = false;
    glob = false;
  };
  const endCommand = () => {
    endWord();
    if (pendingRedirect !== undefined || pendingHeredoc) opaque("redirection without target");
    if (cur.words.length || cur.redirects.length) commands.push(cur);
    cur = { words: [], redirects: [] };
    commands.push(...pendingSubs.splice(0));
  };
  const addSub = (inner: string) => {
    pendingSubs.push(...parse(inner, depth + 1));
    text += SUBSTITUTION_PLACEHOLDER;
    inWord = true;
    dynamic = true;
  };
  /** Handle `$` at `i` (inside or outside double quotes). Returns the next index. */
  const dollar = (at: number): number => {
    const r = scanDollar(src, at);
    if (r.kind === "literal") {
      text += "$";
      inWord = true;
    } else if (r.kind === "sub") {
      addSub(r.inner);
    } else {
      if (r.kind === "dynamic") text += src.slice(at, r.end);
      inWord = true;
      dynamic = true;
    }
    return r.end;
  };
  const readHeredocBodies = () => {
    for (const h of heredocs.splice(0)) {
      const body: string[] = [];
      let closed = false;
      while (i < src.length) {
        const nl = src.indexOf("\n", i);
        const line = src.slice(i, nl < 0 ? src.length : nl);
        i = nl < 0 ? src.length : nl + 1;
        if ((h.stripTabs ? line.replace(/^\t+/, "") : line) === h.delim) {
          closed = true;
          break;
        }
        body.push(line);
      }
      if (!closed) opaque("unterminated here-document");
      if (!h.quoted) {
        const text = body.join("\n");
        commands.push(...expansionsIn(text, depth));
        // An unquoted body expands `$NAME`; model it as `echo "$NAME"` so variable checks see it.
        for (const m of text.matchAll(/(?<!\\)\$\{?[A-Za-z_][A-Za-z0-9_]*/g)) {
          commands.push({
            words: [
              { text: "echo", unresolved: false },
              { text: m[0], unresolved: true },
            ],
            redirects: [],
          });
        }
      }
    }
  };
  const redirection = () => {
    if (inWord && !quoted && !dynamic && /^\d+$/.test(text)) {
      text = "";
      inWord = false;
    } else if (inWord && /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text)) {
      opaque("named file-descriptor redirection");
    } else {
      endWord();
    }
    if (pendingRedirect !== undefined || pendingHeredoc) opaque("redirection without target");
    const c = src[i];
    let op: string;
    if (c === "<") {
      if (src[i + 1] === "<") {
        if (src[i + 2] === "<") op = "<<<";
        else if (src[i + 2] === "-") op = "<<-";
        else op = "<<";
      } else if (src[i + 1] === ">") op = "<>";
      else if (src[i + 1] === "&") op = "<&";
      else if (src[i + 1] === "(") opaque("process substitution");
      else op = "<";
    } else {
      if (src[i + 1] === ">") op = ">>";
      else if (src[i + 1] === "|") op = ">|";
      else if (src[i + 1] === "&") op = ">&";
      else if (src[i + 1] === "(") opaque("process substitution");
      else op = ">";
    }
    i += op.length;
    // zsh clobber forms `>!`, `>>!`, `>&!` (bash would write to a file named `!...`).
    if ((op === ">" || op === ">>" || op === ">&") && src[i] === "!") i += 1;
    if (src[i] === "<" || src[i] === ">") opaque("unknown redirection");
    if (op === "<<" || op === "<<-") pendingHeredoc = { stripTabs: op === "<<-" };
    else pendingRedirect = op;
  };

  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "\\") {
      if (next === "\n") {
        i += 2;
        continue;
      }
      if (next !== undefined) text += next;
      inWord = true;
      quoted = true;
      i += 2;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) opaque("unterminated single quote");
      text += src.slice(i + 1, end);
      inWord = true;
      quoted = true;
      i = end + 1;
    } else if (c === "$" && next === "'") {
      const r = readAnsiC(src, i + 2);
      text += r.text;
      inWord = true;
      quoted = true;
      i = r.end;
    } else if (c === '"' || (c === "$" && next === '"')) {
      inWord = true;
      quoted = true;
      i += c === "$" ? 2 : 1;
      for (;;) {
        if (i >= src.length) opaque("unterminated double quote");
        const d = src[i] as string;
        if (d === '"') {
          i += 1;
          break;
        }
        if (d === "\\" && i + 1 < src.length) {
          const e = src[i + 1] as string;
          if (e === "\n") {
            // line continuation
          } else if ('$`"\\'.includes(e)) text += e;
          else text += d + e;
          i += 2;
        } else if (d === "$") {
          i = dollar(i);
        } else if (d === "`") {
          const r = scanBacktick(src, i + 1);
          i = r.end;
          addSub(r.inner);
        } else {
          text += d;
          i += 1;
        }
      }
    } else if (c === "$") {
      i = dollar(i);
    } else if (c === "`") {
      const r = scanBacktick(src, i + 1);
      i = r.end;
      addSub(r.inner);
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i += 1;
    } else if (c === "\n") {
      endCommand();
      i += 1;
      readHeredocBodies();
    } else if (c === "(") {
      if (next === "(") opaque("arithmetic command (( ))");
      endCommand();
      i += 1;
    } else if (c === ")") {
      endCommand();
      i += 1;
    } else if (c === ";") {
      endCommand();
      i += 1;
      while (src[i] === ";" || src[i] === "&") i += 1;
    } else if (c === "&") {
      if (next === ">") {
        endWord();
        if (pendingRedirect !== undefined || pendingHeredoc) opaque("redirection without target");
        const append = src[i + 2] === ">";
        i += append ? 3 : 2;
        if (src[i] === "!") i += 1; // zsh `&>!`
        if (src[i] === "<" || src[i] === ">") opaque("unknown redirection");
        pendingRedirect = append ? "&>>" : "&>";
      } else {
        endCommand();
        i += next === "&" ? 2 : 1;
      }
    } else if (c === "|") {
      endCommand();
      i += next === "|" || next === "&" ? 2 : 1;
    } else if (c === "<" || c === ">") {
      redirection();
    } else if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i += 1;
    } else {
      if (c === "*" || c === "?" || c === "[" || c === "{") glob = true;
      text += c;
      inWord = true;
      i += 1;
    }
  }
  endCommand();
  if (heredocs.length) opaque("unterminated here-document");
  return commands;
}

type DollarScan =
  | { kind: "literal"; end: number }
  | { kind: "dynamic"; end: number }
  | { kind: "arith"; end: number }
  | { kind: "sub"; end: number; inner: string };

/** Scan a `$` construct starting at `at` (which holds `$`). Throws Opaque on unmodelled forms. */
function scanDollar(src: string, at: number): DollarScan {
  const n = src[at + 1];
  if (n === "(") {
    if (src[at + 2] === "(") {
      const r = scanParen(src, at + 3, 2);
      if (/[^\s\d+\-*/%()<>=!&|^~?:,]/.test(r.inner)) {
        opaque("arithmetic expansion with names or substitutions");
      }
      return { kind: "arith", end: r.end };
    }
    const r = scanParen(src, at + 2, 1);
    if (/\bcase\b/.test(r.inner) || r.inner.includes("<<")) {
      opaque("case or here-document inside command substitution");
    }
    return { kind: "sub", end: r.end, inner: r.inner };
  }
  if (n === "[") opaque("$[ ] arithmetic");
  if (n === "{") {
    const close = src.indexOf("}", at + 2);
    if (close < 0) opaque("unterminated ${");
    if (!SIMPLE_PARAM.test(src.slice(at + 2, close))) opaque("complex parameter expansion");
    return { kind: "dynamic", end: close + 1 };
  }
  if (n !== undefined && /[A-Za-z_]/.test(n)) {
    let j = at + 1;
    while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
    return { kind: "dynamic", end: j };
  }
  if (n !== undefined && /[0-9@*#?$!-]/.test(n)) return { kind: "dynamic", end: at + 2 };
  return { kind: "literal", end: at + 1 };
}

/**
 * `start` is just past the opening paren(s); `closers` is 1 for `$(` and 2 for `$((`. Returns
 * the inner text and the index after the closing paren(s).
 */
function scanParen(src: string, start: number, closers: 1 | 2): { inner: string; end: number } {
  let i = start;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) opaque("unterminated single quote");
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      if (i >= src.length) opaque("unterminated double quote");
      i += 1;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      if (depth === 0) {
        if (closers === 2) {
          if (src[i + 1] !== ")") opaque("malformed arithmetic expansion");
          return { inner: src.slice(start, i), end: i + 2 };
        }
        return { inner: src.slice(start, i), end: i + 1 };
      }
      depth -= 1;
    }
    i += 1;
  }
  opaque("unterminated substitution");
}

/** `start` points just past the opening backtick. */
function scanBacktick(src: string, start: number): { inner: string; end: number } {
  let i = start;
  let inner = "";
  while (i < src.length && src[i] !== "`") {
    if (src[i] === "\\" && i + 1 < src.length) {
      const e = src[i + 1] as string;
      inner += "$`\\".includes(e) ? e : "\\" + e;
      i += 2;
    } else {
      inner += src[i];
      i += 1;
    }
  }
  if (i >= src.length) opaque("unterminated backtick");
  return { inner, end: i + 1 };
}

/** Commands run by expansions inside text the shell expands (unquoted here-document bodies). */
function expansionsIn(body: string, depth: number): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "\\") i += 2;
    else if (c === "$") {
      const r = scanDollar(body, i);
      if (r.kind === "sub") out.push(...parse(r.inner, depth + 1));
      i = r.end;
    } else if (c === "`") {
      const r = scanBacktick(body, i + 1);
      out.push(...parse(r.inner, depth + 1));
      i = r.end;
    } else i += 1;
  }
  return out;
}

const ANSI_SIMPLE: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/** Decode the body of `$'...'`; `start` points just past the opening quote. */
function readAnsiC(src: string, start: number): { text: string; end: number } {
  let i = start;
  let text = "";
  while (i < src.length && src[i] !== "'") {
    const c = src[i] as string;
    if (c !== "\\" || i + 1 >= src.length) {
      text += c;
      i += 1;
      continue;
    }
    const e = src[i + 1] as string;
    i += 2;
    const simple = ANSI_SIMPLE[e];
    if (simple !== undefined) {
      text += simple;
    } else if (e === "x" || e === "u" || e === "U") {
      const max = e === "x" ? 2 : e === "u" ? 4 : 8;
      const m = /^[0-9a-fA-F]+/.exec(src.slice(i, i + max));
      if (m) {
        text += String.fromCodePoint(Math.min(parseInt(m[0], 16), 0x10ffff));
        i += m[0].length;
      } else text += "\\" + e;
    } else if (/[0-7]/.test(e)) {
      const m = /^[0-7]{0,2}/.exec(src.slice(i, i + 2)) as RegExpExecArray;
      text += String.fromCharCode(parseInt(e + m[0], 8) & 0xff);
      i += m[0].length;
    } else if (e === "c" && i < src.length) {
      text += String.fromCharCode((src.charCodeAt(i) as number) & 0x1f);
      i += 1;
    } else {
      text += "\\" + e;
    }
  }
  if (i >= src.length) opaque("unterminated $'...'");
  return { text, end: i + 1 };
}
