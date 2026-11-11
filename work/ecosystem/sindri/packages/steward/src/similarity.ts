const STOPWORDS = new Set(
  "the and for with that this from into onto when what which where should would could have has had are was were will can not but all any our their them they you your use new need needs its it's than then there these those about also been being does done each just more most only other same some such very how why who whom yes".split(
    " ",
  ),
);

/** Lower-case word tokens of three or more letters or digits, without stop words. */
export function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}_]{3,}/gu))
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  return out;
}

/** Jaccard similarity of two token sets (0 when both are empty). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The `limit` items most similar to `query`, best first; ties keep the input order. */
export function mostSimilar<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
  limit: number,
): { item: T; score: number }[] {
  const q = tokens(query);
  return items
    .map((item, i) => ({ item, i, score: jaccard(q, tokens(text(item))) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));
}
