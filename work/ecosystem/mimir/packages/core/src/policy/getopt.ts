import type { ShellWord } from "./shell.js";

/**
 * A compact getopt_long model used by the command classifier.
 *
 * Option tables are written in a small DSL: comma-separated entries, each `names` followed by
 * suffix flags. Names are separated by `|`; one character means a short option, longer means a
 * long option. Suffixes:
 *
 * - `=`  takes one value (`-o file`, `-ofile`, `--out file`, `--out=file`)
 * - `==` takes two values (`--arg name value`)
 * - `?`  the long form takes an optional `=value`
 * - `*`  the short form takes an optional attached value too (`-uno`)
 * - `!`  exec-capable: using it makes the command unclassifiable
 * - `>`  the value is a path that will be written
 * - `<`  the value is a path that will be read
 *
 * Example: `"o|output=>,v|verbose,pre=!"`.
 */
export interface OptDef {
  key: string;
  shorts: string[];
  longs: string[];
  arity: 0 | 1 | 2;
  longOptional: boolean;
  shortOptional: boolean;
  exec: boolean;
  write: boolean;
  read: boolean;
  /** If set, the value must be one of these. */
  values?: ReadonlySet<string>;
}

export interface OptTable {
  short: ReadonlyMap<string, OptDef>;
  long: ReadonlyMap<string, OptDef>;
  /** Accept `-<digits>` (e.g. `head -5`, `git log -3`). */
  numeric: boolean;
  /** GNU argument permutation: options may follow operands. */
  permute: boolean;
  /** git-style `--no-<option>` for value-less options. */
  negatable: boolean;
}

export interface TableFlags {
  numeric?: boolean;
  permute?: boolean;
  negatable?: boolean;
  /** Restrict option values: key -> allowed values. */
  values?: Record<string, readonly string[]>;
}

export function opts(dsl: string, flags: TableFlags = {}): OptTable {
  const short = new Map<string, OptDef>();
  const long = new Map<string, OptDef>();
  for (const raw of dsl.split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const m = /^([^=?*!<>]+)([=?*!<>]*)$/.exec(entry);
    if (!m) throw new Error(`bad option entry: ${entry}`);
    const names = (m[1] as string).split("|");
    const suffix = m[2] as string;
    const shorts = names.filter((n) => n.length === 1);
    const longs = names.filter((n) => n.length > 1);
    const eq = (suffix.match(/=/g) ?? []).length;
    const def: OptDef = {
      key: longs[longs.length - 1] ?? (shorts[0] as string),
      shorts,
      longs,
      arity: eq === 0 ? 0 : eq === 1 ? 1 : 2,
      longOptional: suffix.includes("?") || suffix.includes("*"),
      shortOptional: suffix.includes("*"),
      exec: suffix.includes("!"),
      write: suffix.includes(">"),
      read: suffix.includes("<"),
    };
    const allowed = flags.values?.[def.key];
    if (allowed) def.values = new Set(allowed);
    for (const s of shorts) short.set(s, def);
    for (const l of longs) long.set(l, def);
  }
  return {
    short,
    long,
    numeric: flags.numeric ?? false,
    permute: flags.permute ?? true,
    negatable: flags.negatable ?? false,
  };
}

export interface ParsedOpt {
  def: OptDef;
  /** As written, without dashes. */
  name: string;
  negated: boolean;
  values: ShellWord[];
}

export interface Parsed {
  ok: true;
  opts: ParsedOpt[];
  operands: ShellWord[];
  /** Index (into operands) of the first operand after `--`, or -1. */
  dashDashAt: number;
}

export interface ParseFailure {
  ok: false;
  reason: "unknown" | "ambiguous" | "exec" | "arity" | "unresolved" | "value";
  option: string;
}

/** Resolve `--name` the way getopt_long does: exact match, else a unique prefix. */
export function resolveLong(
  table: OptTable,
  name: string,
): { def: OptDef; negated: boolean } | "unknown" | "ambiguous" {
  const exact = table.long.get(name);
  if (exact) return { def: exact, negated: false };
  if (table.negatable && name.startsWith("no-")) {
    const base = table.long.get(name.slice(3));
    if (base && base.arity === 0) return { def: base, negated: true };
  }
  const found = new Map<OptDef, boolean>();
  for (const [l, def] of table.long) {
    if (l.startsWith(name)) found.set(def, false);
    if (table.negatable && def.arity === 0 && `no-${l}`.startsWith(name)) found.set(def, true);
  }
  if (found.size === 0) return "unknown";
  if (found.size > 1) return "ambiguous";
  const [def, negated] = [...found][0] as [OptDef, boolean];
  return { def, negated };
}

const word = (text: string, unresolved: boolean): ShellWord => ({ text, unresolved });

export function getopt(table: OptTable, words: readonly ShellWord[]): Parsed | ParseFailure {
  const out: ParsedOpt[] = [];
  const operands: ShellWord[] = [];
  let dashDashAt = -1;
  let onlyOperands = false;

  const take = (def: OptDef, name: string, values: ShellWord[]): ParseFailure | undefined => {
    if (def.exec) return { ok: false, reason: "exec", option: name };
    for (const v of values) {
      if (def.values && !def.values.has(v.text))
        return { ok: false, reason: "value", option: name };
    }
    out.push({ def, name, negated: false, values });
    return undefined;
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i] as ShellWord;
    const t = w.text;
    if (onlyOperands || !t.startsWith("-") || t === "-") {
      operands.push(w);
      if (!table.permute) onlyOperands = true;
      continue;
    }
    if (t === "--") {
      onlyOperands = true;
      dashDashAt = operands.length;
      continue;
    }
    if (w.unresolved) return { ok: false, reason: "unresolved", option: t };

    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const name = eq >= 0 ? t.slice(2, eq) : t.slice(2);
      const inline = eq >= 0 ? t.slice(eq + 1) : undefined;
      const r = resolveLong(table, name);
      if (r === "unknown" || r === "ambiguous") return { ok: false, reason: r, option: t };
      const { def, negated } = r;
      if (def.exec) return { ok: false, reason: "exec", option: t };
      const values: ShellWord[] = [];
      if (def.arity === 0 || negated) {
        if (inline !== undefined && !(def.longOptional && !negated)) {
          return { ok: false, reason: "arity", option: t };
        }
        if (inline !== undefined) values.push(word(inline, w.unresolved));
      } else if (def.arity === 1) {
        if (inline !== undefined) values.push(word(inline, w.unresolved));
        else if (def.longOptional) {
          // optional value only when attached
        } else {
          const v = words[++i];
          if (!v) return { ok: false, reason: "arity", option: t };
          values.push(v);
        }
      } else {
        if (inline !== undefined) return { ok: false, reason: "arity", option: t };
        const a = words[++i];
        const b = words[++i];
        if (!a || !b) return { ok: false, reason: "arity", option: t };
        values.push(a, b);
      }
      if (negated) {
        out.push({ def, name, negated: true, values });
        continue;
      }
      const f = take(def, name, values);
      if (f) return f;
      continue;
    }

    // short cluster
    if (table.numeric && /^-\d+$/.test(t)) {
      continue;
    }
    for (let j = 1; j < t.length; j++) {
      const c = t[j] as string;
      const def = table.short.get(c);
      if (!def) return { ok: false, reason: "unknown", option: `-${c}` };
      if (def.exec) return { ok: false, reason: "exec", option: `-${c}` };
      const rest = t.slice(j + 1);
      if (def.arity === 0) {
        if (def.shortOptional && rest) {
          const f = take(def, c, [word(rest, w.unresolved)]);
          if (f) return f;
          break;
        }
        const f = take(def, c, []);
        if (f) return f;
        continue;
      }
      if (def.arity === 1) {
        let v: ShellWord | undefined;
        if (rest) v = word(rest, w.unresolved);
        else if (def.shortOptional) v = undefined;
        else v = words[++i];
        if (!v && !def.shortOptional) return { ok: false, reason: "arity", option: `-${c}` };
        const f = take(def, c, v ? [v] : []);
        if (f) return f;
        break;
      }
      // arity 2
      if (rest) return { ok: false, reason: "arity", option: `-${c}` };
      const a = words[++i];
      const b = words[++i];
      if (!a || !b) return { ok: false, reason: "arity", option: `-${c}` };
      const f = take(def, c, [a, b]);
      if (f) return f;
      break;
    }
  }
  return { ok: true, opts: out, operands, dashDashAt };
}

export function has(parsed: Parsed, ...keys: string[]): boolean {
  return parsed.opts.some((o) => !o.negated && keys.includes(o.def.key));
}

export function valueOf(parsed: Parsed, key: string): ShellWord | undefined {
  for (let i = parsed.opts.length - 1; i >= 0; i--) {
    const o = parsed.opts[i] as ParsedOpt;
    if (o.def.key === key && !o.negated) return o.values[0];
  }
  return undefined;
}
