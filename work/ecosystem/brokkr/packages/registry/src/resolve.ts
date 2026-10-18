import semver from "semver";
import {
  BrokkrError,
  type LoadedHarness,
  type LoadedSkill,
  type ResolvedHarness,
  type ResolvedHarnessSet,
} from "@brokkr/core";

export interface ResolveRequest {
  harnesses: Array<{ name: string; range: string }>;
  /**
   * Allow candidates from untrusted sources (they resolve with
   * `executionAllowed: false`). Off by default: an untrusted harness is only
   * selectable once its source is pinned with `trusted: true`. Callers that
   * enable this must refuse to execute or emit its content (see `prepare`).
   */
  allowUntrusted?: boolean;
}

/** Source precedence (spec §5.1): lower tier wins before semver is considered. */
export const SOURCE_PRECEDENCE: Record<LoadedHarness["source"], number> = {
  builtin: 0,
  user: 1,
  project: 2,
  external: 3,
};

export interface ResolveOptions {
  platform?: NodeJS.Platform;
  brokkrVersion?: string;
}

interface Constraint {
  range: string;
  from: string;
}

const id = (h: LoadedHarness): string =>
  `${h.manifest.metadata.name}@${h.manifest.metadata.version}`;

/**
 * Resolve requested harnesses and their `dependsOn` closure. For each name the
 * highest available version satisfying every range seen is selected; the
 * pass repeats until the selection is stable. Conflicts and incompatibilities
 * are errors, never silently skipped.
 */
export function resolveHarnessSet(
  available: readonly LoadedHarness[],
  request: ResolveRequest,
  options: ResolveOptions = {},
): ResolvedHarnessSet {
  const byName = new Map<string, LoadedHarness[]>();
  for (const h of available) {
    const list = byName.get(h.manifest.metadata.name) ?? [];
    list.push(h);
    byName.set(h.manifest.metadata.name, list);
  }
  // Precedence tier first, then highest version within a tier: a lower-trust
  // source can never shadow a higher one by publishing a bigger version.
  for (const list of byName.values())
    list.sort(
      (a, b) =>
        SOURCE_PRECEDENCE[a.source] - SOURCE_PRECEDENCE[b.source] ||
        semver.rcompare(a.manifest.metadata.version, b.manifest.metadata.version),
    );

  for (const r of request.harnesses) {
    if (semver.validRange(r.range) === null) {
      throw new BrokkrError(
        "invalid-config",
        `invalid version range '${r.range}' for harness '${r.name}'`,
      );
    }
  }

  let previous = new Map<string, Constraint[]>();
  for (let iteration = 0; iteration < 25; iteration++) {
    const constraints = new Map<string, Constraint[]>();
    const add = (name: string, c: Constraint): void => {
      const list = constraints.get(name) ?? [];
      list.push(c);
      constraints.set(name, list);
    };
    for (const r of request.harnesses) add(r.name, { range: r.range, from: "request" });

    const selected = new Map<string, LoadedHarness>();
    const order: string[] = [];
    const queue = request.harnesses.map((r) => r.name);
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (selected.has(name)) continue;
      const candidates = byName.get(name);
      if (!candidates || candidates.length === 0) {
        const from = (constraints.get(name) ?? []).map((c) => c.from).join(", ");
        throw new BrokkrError(
          "not-found",
          `harness '${name}' not found in any registry source (required by ${from})`,
        );
      }
      const current = constraints.get(name) ?? [];
      const informed = [...current, ...(previous.get(name) ?? [])];
      const satisfiesAll = (h: LoadedHarness, cs: Constraint[]): boolean =>
        cs.every((c) => semver.satisfies(h.manifest.metadata.version, c.range));
      const selectable = request.allowUntrusted
        ? candidates
        : candidates.filter((h) => h.trust === "trusted");
      const pick =
        selectable.find((h) => satisfiesAll(h, informed)) ??
        selectable.find((h) => satisfiesAll(h, current));
      if (!pick) {
        const untrusted = candidates.find((h) => h.trust !== "trusted" && satisfiesAll(h, current));
        if (untrusted) {
          throw new BrokkrError(
            "trust_required",
            `harness ${id(untrusted)} is only available from untrusted source ${untrusted.sourceRef}; review it and pin it with \`brokkr trust add <source> --digest <sha256>\` before it can be selected`,
            { details: { harness: id(untrusted), source: untrusted.sourceRef } },
          );
        }
        throw versionConflict(name, current, candidates);
      }
      selected.set(name, pick);
      order.push(name);
      for (const dep of pick.manifest.dependsOn ?? []) {
        add(dep.name, { range: dep.version, from: id(pick) });
        queue.push(dep.name);
      }
    }

    const unstable = [...selected].filter(([name, h]) =>
      (constraints.get(name) ?? []).some(
        (c) => !semver.satisfies(h.manifest.metadata.version, c.range),
      ),
    );
    if (unstable.length === 0) return finish(selected, constraints, options);
    if (iteration > 0 && sameConstraints(previous, constraints)) {
      const [name] = unstable[0]!;
      throw versionConflict(name, constraints.get(name) ?? [], byName.get(name) ?? []);
    }
    previous = constraints;
  }
  throw new BrokkrError("version-conflict", "harness resolution did not converge");
}

function sameConstraints(a: Map<string, Constraint[]>, b: Map<string, Constraint[]>): boolean {
  const key = (m: Map<string, Constraint[]>): string =>
    JSON.stringify([...m].map(([k, v]) => [k, v.map((c) => `${c.range}<${c.from}`).sort()]).sort());
  return key(a) === key(b);
}

function versionConflict(
  name: string,
  constraints: Constraint[],
  candidates: LoadedHarness[],
): BrokkrError {
  const wants = constraints.map((c) => `${c.range} (from ${c.from})`).join(", ");
  const have = candidates.map((h) => h.manifest.metadata.version).join(", ") || "none";
  return new BrokkrError(
    "version-conflict",
    `no version of '${name}' satisfies ${wants}; available: ${have}`,
    {
      details: { name, constraints, available: candidates.map((h) => h.manifest.metadata.version) },
    },
  );
}

function finish(
  selected: Map<string, LoadedHarness>,
  constraints: Map<string, Constraint[]>,
  options: ResolveOptions,
): ResolvedHarnessSet {
  for (const h of selected.values()) {
    for (const other of h.manifest.conflictsWith ?? []) {
      const hit = selected.get(other);
      if (hit) {
        throw new BrokkrError("harness-conflict", `harness ${id(h)} conflicts with ${id(hit)}`, {
          details: { harness: id(h), conflictsWith: id(hit) },
        });
      }
    }
    if (
      options.platform &&
      !h.manifest.compatibility.platforms.includes(options.platform as "darwin")
    ) {
      throw new BrokkrError(
        "incompatible",
        `harness ${id(h)} supports ${h.manifest.compatibility.platforms.join(", ")}, not ${options.platform}`,
      );
    }
    const range = h.manifest.compatibility.brokkr;
    if (range && options.brokkrVersion && !semver.satisfies(options.brokkrVersion, range)) {
      throw new BrokkrError(
        "incompatible",
        `harness ${id(h)} requires brokkr ${range}, running ${options.brokkrVersion}`,
      );
    }
  }

  // Topological order (dependencies first), ties broken by name.
  const ordered: LoadedHarness[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name))
      throw new BrokkrError("version-conflict", `dependency cycle through harness '${name}'`);
    visiting.add(name);
    const h = selected.get(name)!;
    for (const dep of [...(h.manifest.dependsOn ?? [])].map((d) => d.name).sort()) visit(dep);
    visiting.delete(name);
    visited.add(name);
    ordered.push(h);
  };
  for (const name of [...selected.keys()].sort()) visit(name);

  const harnesses: ResolvedHarness[] = ordered.map((h) => ({
    ...h,
    executionAllowed: h.trust === "trusted",
    requestedBy: [...new Set((constraints.get(h.manifest.metadata.name) ?? []).map((c) => c.from))],
  }));

  const skills: Record<string, LoadedSkill> = {};
  for (const h of harnesses) {
    for (const skill of h.skills) {
      const name = skill.manifest.metadata.name;
      const existing = skills[name];
      if (!existing) {
        skills[name] = skill;
        continue;
      }
      if (
        existing.manifest.metadata.version !== skill.manifest.metadata.version ||
        existing.digest !== skill.digest
      ) {
        throw new BrokkrError(
          "skill-conflict",
          `skill '${name}' is provided by ${existing.providedBy} (${existing.manifest.metadata.version}) and ${skill.providedBy} (${skill.manifest.metadata.version}) with different content`,
        );
      }
    }
  }
  return { harnesses, skills };
}
