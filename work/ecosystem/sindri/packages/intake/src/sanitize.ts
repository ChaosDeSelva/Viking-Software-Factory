// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Bidi embeddings/overrides/isolates and marks, zero-width characters, word joiner and BOM:
// invisible characters that can reorder or disguise displayed text (Trojan Source style), plus
// soft hyphen, CGJ, variation selectors, interlinear annotations and Unicode tag characters
// (ASCII smuggling, review Ssec I3).
const INVISIBLE =
  // eslint-disable-next-line no-misleading-character-class -- each invisible code point is matched on its own, combining marks included
  /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFE00-\uFE0F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const SCRIPT_URL = /\b(javascript|vbscript)\s*:/gi;
const DATA_URL = /\bdata\s*:\s*([a-z]+\/[a-z0-9.+-]+)/gi;

/** Script-like elements whose content is removed together with the tags. */
const BLOCK_ELEMENTS = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "noscript",
  "template",
]);

/** Inputs longer than this (in UTF-16 units) are cut before sanitizing (audit M5). */
export const MAX_DISPLAY_CHARS = 64 * 1024;
export const TRUNCATION_MARKER = "\n[truncated]";

const isAlpha = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
/** `<` followed by `[A-Za-z!?]` or `/[A-Za-z!?]`: the start of something tag-like. */
const isTagStartAt = (s: string, i: number) => {
  let j = i + 1;
  if (s.charCodeAt(j) === 47 /* / */) j++;
  const c = s.charCodeAt(j);
  return isAlpha(c) || c === 33 /* ! */ || c === 63; /* ? */
};
const nameAt = (s: string, i: number) => {
  let j = i;
  while (j < s.length && j - i < 16 && isAlpha(s.charCodeAt(j))) j++;
  return s.slice(i, j).toLowerCase();
};

/**
 * Single-pass tag stripper. Characters are appended to an output buffer; whenever a `>`
 * completes a tag at the end of the buffer, the tag is removed from the buffer. Because
 * matching happens on the *output*, fragments that reassemble into a tag once something in
 * between was removed (`<scr<b></b>ipt>`) are caught too, without re-scanning. Each character
 * is appended and removed at most once, so the whole pass is linear.
 */
function stripMarkup(input: string): string {
  const out: string[] = [];
  /** Output positions of `<` characters that have not been consumed by a completed tag. */
  const lts: number[] = [];
  /** Open script-like blocks (output position of their `<`), overall and per element name. */
  const blocks: { name: string; pos: number }[] = [];
  const byName = new Map<string, number[]>();
  const truncate = (len: number) => {
    out.length = len;
    while (lts.length && lts[lts.length - 1]! >= len) lts.pop();
    while (blocks.length && blocks[blocks.length - 1]!.pos >= len)
      byName.get(blocks.pop()!.name)!.pop();
  };
  const tagLikeAt = (lt: number) =>
    isTagStartAt(out[lt]! + (out[lt + 1] ?? "") + (out[lt + 2] ?? ""), 0);

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    out.push(ch);
    const len = out.length;
    if (ch === "<") {
      lts.push(len - 1);
      continue;
    }
    // A comment opener at the end of the buffer: drop everything through the next `-->`.
    if (ch === "-" && len >= 4 && lts.length && lts[lts.length - 1] === len - 4) {
      if (out[len - 3] === "!" && out[len - 2] === "-") {
        const end = input.indexOf("-->", i + 1);
        truncate(len - 4);
        if (end === -1) break;
        i = end + 2;
        continue;
      }
    }
    if (ch !== ">" || !lts.length) continue;
    const lt = lts[lts.length - 1]!;
    if (!tagLikeAt(lt)) continue; // "a < b > c": plain text, checked in O(1)
    // Amortised linear: a tag-like candidate leaves the buffer (or the `<` stack) below.
    const candidate = out.slice(lt).join("");
    const closing = candidate.charCodeAt(1) === 47;
    const name = nameAt(candidate, closing ? 2 : 1);
    if (closing) {
      // `</name\s*>` closes the innermost open block of that name and everything inside it.
      let k = 2 + name.length;
      while (k < candidate.length - 1 && isSpace(candidate.charCodeAt(k))) k++;
      const open = k === candidate.length - 1 ? byName.get(name) : undefined;
      if (open?.length) {
        truncate(open[open.length - 1]!);
        continue;
      }
      truncate(lt);
      continue;
    }
    const after = candidate.charCodeAt(1 + name.length);
    if (BLOCK_ELEMENTS.has(name) && !isAlpha(after) && !(after >= 48 && after <= 57)) {
      // Keep the opener in the buffer (it marks where the block's removal starts).
      blocks.push({ name, pos: lt });
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name)!.push(lt);
      lts.pop();
      continue;
    }
    truncate(lt);
  }
  // An unclosed block runs to the end of the text.
  if (blocks.length) truncate(blocks[0]!.pos);
  // Drop trailing unterminated tags (`x <iframe src=evil`).
  while (lts.length) {
    const lt = lts[lts.length - 1]!;
    if (!tagLikeAt(lt)) break;
    truncate(lt);
  }
  return out.join("");
}

/**
 * Convert untrusted ticket text (Jira/Linear/manual) into inert plain text for display:
 * removes script-like blocks with their content, HTML comments, all tags (including tags that
 * reassemble once something between their pieces is removed), control characters, bidi and
 * zero-width characters, and script/data URLs. Runs in linear time and caps its input at
 * {@link MAX_DISPLAY_CHARS}. It never evaluates or interprets the text.
 */
export function sanitizeForDisplay(input: string): string {
  let src = input;
  let truncated = false;
  if (src.length > MAX_DISPLAY_CHARS) {
    src = src.slice(0, MAX_DISPLAY_CHARS);
    // Do not leave half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(src)) src = src.slice(0, -1);
    truncated = true;
  }
  const s = stripMarkup(src.replace(CONTROL, "").replace(INVISIBLE, ""))
    .replace(SCRIPT_URL, "$1-blocked:")
    .replace(DATA_URL, "data-blocked:$1");
  return truncated ? s + TRUNCATION_MARKER : s;
}
