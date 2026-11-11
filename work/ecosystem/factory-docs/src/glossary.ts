import { docHref, slugify } from "./markdown.js";
import { APP_NAMES } from "./navigation.js";
import { APP_GROUPS, STATUS_GROUPS, type StatusGroup, type StatusValue } from "./statuses.js";
import { TERMS } from "./terms.js";
import { APP_IDS, type AppId, type GlossaryEntry, type StatusRef } from "./types.js";

export const statusTermName = (group: StatusGroup, value: StatusValue): string =>
  `${value.label} (${group.noun} status)`;

/** Apps that show a status group, in the order of APP_IDS. */
export function groupApps(key: string): AppId[] {
  return APP_IDS.filter((app) => APP_GROUPS[app].includes(key));
}

const list = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

function statusEntries(): GlossaryEntry[] {
  const out: GlossaryEntry[] = [];
  for (const group of STATUS_GROUPS) {
    const shownIn = list(groupApps(group.key).map((a) => APP_NAMES[a]));
    for (const value of group.values) {
      const term = statusTermName(group, value);
      out.push({
        id: slugify(term),
        term,
        short: value.short,
        long: [
          value.more ? `${value.short} ${value.more}` : value.short,
          `Raw value: \`${value.value}\`. Shown in ${shownIn}.`,
        ].join("\n\n"),
        seeAlso: [group.concept],
        category: "status",
        aliases: [value.value],
      });
    }
  }
  return out;
}

function conceptEntries(): GlossaryEntry[] {
  return TERMS.map((t) => ({
    id: slugify(t.term),
    term: t.term,
    short: t.short,
    long: t.long ? `${t.short}\n\n${t.long}` : t.short,
    seeAlso: t.see,
    category: t.category,
    aliases: t.aliases ?? [],
  }));
}

/** Concepts first, then every status value. */
export const glossary: readonly GlossaryEntry[] = [...conceptEntries(), ...statusEntries()];

const byId = new Map(glossary.map((e) => [e.id, e]));
const byName = new Map<string, GlossaryEntry>();
for (const e of glossary) {
  if (e.category === "status") continue;
  for (const name of [e.term, ...e.aliases]) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, e);
  }
}

/** By id, term or alias, case-insensitive. Status entries resolve by id only; use `statusInfo`. */
export function getTerm(idOrName: string): GlossaryEntry | undefined {
  return (
    byId.get(idOrName) ?? byName.get(idOrName.trim().toLowerCase()) ?? byId.get(slugify(idOrName))
  );
}

/** Status entries live on the statuses page; concepts on the glossary page. */
export function termHref(entry: GlossaryEntry): string {
  return docHref(entry.category === "status" ? "statuses" : "glossary", entry.id);
}

/** Every (app, group, value) the apps show. */
export const statuses: readonly StatusRef[] = APP_IDS.flatMap((app) =>
  APP_GROUPS[app].flatMap((key) => {
    const group = STATUS_GROUPS.find((g) => g.key === key);
    if (!group) throw new Error(`APP_GROUPS.${app} names unknown status group ${key}`);
    return group.values.map((value) => ({
      app,
      domain: group.key,
      value: value.value,
      label: value.label,
      term: slugify(statusTermName(group, value)),
    }));
  }),
);

const normalize = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

export interface StatusInfo {
  app: AppId;
  domain: string;
  /** The raw value as passed in. */
  raw: string;
  label: string;
  short: string;
  term: string;
  href: string;
}

/**
 * Plain-words meaning of a status. Case, spaces and hyphens are ignored (`Not paired` matches
 * `not_paired`). Without `domain` the app's most common meaning wins. Unknown values return
 * undefined: show the raw value with the `unknown` role, never throw.
 */
export function statusInfo(app: AppId, value: string, domain?: string): StatusInfo | undefined {
  const wanted = normalize(value);
  const keys = domain === undefined ? (APP_GROUPS[app] ?? []) : [domain];
  for (const key of keys) {
    const group = STATUS_GROUPS.find((g) => g.key === key);
    const hit = group?.values.find((v) => normalize(v.value) === wanted);
    if (!group || !hit) continue;
    const id = slugify(statusTermName(group, hit));
    return {
      app,
      domain: key,
      raw: value,
      label: hit.label,
      short: hit.short,
      term: id,
      href: docHref("statuses", id),
    };
  }
  return undefined;
}
