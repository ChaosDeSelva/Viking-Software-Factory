/** Minimal semver used by the fake service: `x.y.z` versions; `*`, exact, `^` and `~` ranges. */
type Triple = [number, number, number];

export function parseVersion(v: string): Triple | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a semver version: ${x ? b : a}`);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** `undefined` when the range syntax is unsupported. */
export function satisfies(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (!v) return false;
  if (range === "*") return true;
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const base = parseVersion(range.slice(op.length));
  if (!base) return undefined;
  if (compareVersions(version, range.slice(op.length)) < 0) return false;
  if (op === "") return compareVersions(version, range) === 0;
  if (op === "~") return v[0] === base[0] && v[1] === base[1];
  return base[0] > 0 ? v[0] === base[0] : v[0] === 0 && v[1] === base[1];
}
