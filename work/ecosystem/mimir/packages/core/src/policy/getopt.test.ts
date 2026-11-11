import { describe, expect, it } from "vitest";
import { getopt, has, opts, resolveLong, valueOf, type Parsed } from "./getopt.js";
import type { ShellWord } from "./shell.js";

const w = (...texts: string[]): ShellWord[] => texts.map((text) => ({ text, unresolved: false }));
const dyn = (text: string): ShellWord => ({ text, unresolved: true });

const T = opts(
  "v|verbose,o|output=>,i|input=<,u|untracked*,color?,arg==,x|exec!,m|mode=,verify,version",
  { negatable: true, numeric: true, values: { mode: ["a", "b"] } },
);

function ok(r: ReturnType<typeof getopt>): Parsed {
  if (!r.ok) throw new Error(`parse failed: ${r.reason} ${r.option}`);
  return r;
}

describe("opts", () => {
  it("rejects a malformed entry", () => {
    expect(() => opts("a=b")).toThrow(/bad option entry: a=b/);
  });
  it("records the suffix flags", () => {
    const o = T.long.get("output");
    expect(o).toMatchObject({ key: "output", shorts: ["o"], arity: 1, write: true, read: false });
    expect(T.long.get("arg")).toMatchObject({ arity: 2 });
    expect(T.short.get("u")).toMatchObject({ arity: 0, shortOptional: true, longOptional: true });
    expect(T.long.get("color")).toMatchObject({ longOptional: true, shortOptional: false });
    expect(T.short.get("x")?.exec).toBe(true);
    expect([...(T.long.get("mode")?.values ?? [])]).toEqual(["a", "b"]);
  });
});

describe("resolveLong", () => {
  it("resolves exact names, negations, unique prefixes and reports ambiguity", () => {
    expect(resolveLong(T, "verbose")).toMatchObject({ negated: false });
    expect(resolveLong(T, "no-verbose")).toMatchObject({ negated: true });
    // `--no-output` is not a negation (output takes a value) and matches nothing else.
    expect(resolveLong(T, "no-output")).toBe("unknown");
    expect(resolveLong(T, "no-verb")).toMatchObject({ negated: true, def: T.long.get("verbose") });
    expect(resolveLong(T, "out")).toMatchObject({ def: T.long.get("output") });
    expect(resolveLong(T, "ver")).toBe("ambiguous"); // verbose, verify, version
    expect(resolveLong(T, "nope")).toBe("unknown");
  });
});

describe("getopt long options", () => {
  it("fails on an unresolved option word", () => {
    expect(getopt(T, [dyn("--$X")])).toEqual({ ok: false, reason: "unresolved", option: "--$X" });
  });
  it("rejects an inline value on a flag and on a negation, but takes one on an optional", () => {
    expect(getopt(T, w("--verbose=1"))).toMatchObject({ ok: false, reason: "arity" });
    expect(getopt(T, w("--no-verbose=1"))).toMatchObject({ ok: false, reason: "arity" });
    const p = ok(getopt(T, w("--color=never")));
    expect(p.opts[0]?.values.map((v) => v.text)).toEqual(["never"]);
    expect(ok(getopt(T, w("--color", "x"))).operands.map((v) => v.text)).toEqual(["x"]);
  });
  it("reads a separate value and fails when it is missing", () => {
    expect(valueOf(ok(getopt(T, w("--output", "f"))), "output")?.text).toBe("f");
    expect(getopt(T, w("--output"))).toMatchObject({ ok: false, reason: "arity" });
  });
  it("takes two values for `==`, never inline, and fails when one is missing", () => {
    const p = ok(getopt(T, w("--arg", "k", "v", "rest")));
    expect(p.opts[0]?.values.map((v) => v.text)).toEqual(["k", "v"]);
    expect(p.operands.map((v) => v.text)).toEqual(["rest"]);
    expect(getopt(T, w("--arg=k", "v"))).toMatchObject({ ok: false, reason: "arity" });
    expect(getopt(T, w("--arg", "k"))).toMatchObject({ ok: false, reason: "arity" });
  });
  it("records a negation without counting it as set", () => {
    const p = ok(getopt(T, w("--no-verbose")));
    expect(p.opts[0]).toMatchObject({ negated: true, name: "no-verbose" });
    expect(has(p, "verbose")).toBe(false);
  });
  it("fails on exec-capable options and on values outside the allowed set", () => {
    expect(getopt(T, w("--exec"))).toMatchObject({ ok: false, reason: "exec" });
    expect(getopt(T, w("--mode=c"))).toMatchObject({ ok: false, reason: "value", option: "mode" });
    expect(valueOf(ok(getopt(T, w("--mode=a", "--mode", "b"))), "mode")?.text).toBe("b");
  });
});

describe("getopt short options", () => {
  it("skips numeric options only when the table allows them", () => {
    expect(ok(getopt(T, w("-5"))).opts).toEqual([]);
    expect(getopt(opts("v"), w("-5"))).toMatchObject({
      ok: false,
      reason: "unknown",
      option: "-5",
    });
  });
  it("takes an attached optional value and ends the cluster there", () => {
    const p = ok(getopt(T, w("-uno")));
    expect(p.opts).toHaveLength(1);
    expect(p.opts[0]?.values.map((v) => v.text)).toEqual(["no"]);
    expect(ok(getopt(T, w("-vu"))).opts.map((o) => o.def.key)).toEqual(["verbose", "untracked"]);
  });
  it("applies value restrictions to clusters", () => {
    expect(getopt(T, w("-mc"))).toMatchObject({ ok: false, reason: "value", option: "m" });
    expect(getopt(T, w("-vmc"))).toMatchObject({ ok: false, reason: "value" });
    const restricted = opts("u*", { values: { u: ["no"] } });
    expect(getopt(restricted, w("-uall"))).toMatchObject({ ok: false, reason: "value" });
  });
  it("reads attached and separate values; a missing value fails", () => {
    expect(valueOf(ok(getopt(T, w("-vofile"))), "output")?.text).toBe("file");
    expect(valueOf(ok(getopt(T, w("-o", "file"))), "output")?.text).toBe("file");
    expect(getopt(T, w("-o"))).toMatchObject({ ok: false, reason: "arity", option: "-o" });
  });
  it("an optional arity-1 short option takes no separate word", () => {
    const t = opts("c*=");
    const p = ok(getopt(t, w("-c", "x")));
    expect(p.opts[0]?.values).toEqual([]);
    expect(p.operands.map((v) => v.text)).toEqual(["x"]);
  });
  it("an arity-2 short option takes two separate words, never attached ones", () => {
    const t = opts("a==,b");
    const p = ok(getopt(t, w("-a", "k", "v", "-b")));
    expect(p.opts.map((o) => o.values.map((v) => v.text))).toEqual([["k", "v"], []]);
    expect(getopt(t, w("-ak", "v"))).toMatchObject({ ok: false, reason: "arity", option: "-a" });
    expect(getopt(t, w("-a", "k"))).toMatchObject({ ok: false, reason: "arity", option: "-a" });
    expect(getopt(opts("a==!"), w("-a", "k", "v"))).toMatchObject({ ok: false, reason: "exec" });
  });
  it("marks an attached value from an unresolved word as unresolved", () => {
    // Only the leading-dash check rejects unresolved words; values inherit the flag.
    expect(getopt(T, [dyn("-o$X")])).toMatchObject({ ok: false, reason: "unresolved" });
  });
});

describe("operands", () => {
  it("`--` ends options and records where operands after it start", () => {
    const p = ok(getopt(T, w("a", "--", "-v", "--output")));
    expect(p.opts).toEqual([]);
    expect(p.operands.map((v) => v.text)).toEqual(["a", "-v", "--output"]);
    expect(p.dashDashAt).toBe(1);
  });
  it("without permutation the first operand ends options", () => {
    const t = opts("v", { permute: false });
    const p = ok(getopt(t, w("x", "-v")));
    expect(p.opts).toEqual([]);
    expect(p.operands.map((v) => v.text)).toEqual(["x", "-v"]);
    expect(ok(getopt(t, w("-", "-v"))).operands.map((v) => v.text)).toEqual(["-", "-v"]);
  });
});
