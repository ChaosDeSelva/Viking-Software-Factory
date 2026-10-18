// pnpm sbom
// Produces a CycloneDX 1.5 JSON SBOM at dist/sbom.cdx.json from `pnpm list -r --json --depth Infinity`
// (@cyclonedx/cyclonedx-npm drives `npm ls` and does not understand pnpm's layout, so it is not used).
// Workspace packages become components too; every component carries a pkg:npm purl and its license.
// Flags: --root <dir> (default: repo root), --out <file> (default: <root>/dist/sbom.cdx.json).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export function purl(name, version) {
  const enc = (s) => encodeURIComponent(s).replace(/%40/g, "%40");
  if (name.startsWith("@")) {
    const [scope, rest] = name.split("/");
    return `pkg:npm/${enc(scope)}/${enc(rest)}@${enc(version)}`;
  }
  return `pkg:npm/${enc(name)}@${enc(version)}`;
}

const pnpmJson = (args, cwd) =>
  JSON.parse(
    execFileSync("pnpm", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }) || "[]",
  );

function licenseEntries(expression) {
  if (!expression) return undefined;
  return /\s(OR|AND)\s|^\(/.test(expression) ? [{ expression }] : [{ license: { id: expression } }];
}

// Pure builder: `tree` is the `pnpm list -r --json --depth Infinity` output, `licenses` maps name@version to SPDX.
export function buildSbom({
  tree,
  licenses = {},
  rootName = "workspace",
  timestamp = new Date().toISOString(),
  serialNumber = `urn:uuid:${randomUUID()}`,
}) {
  const workspaceByPath = new Map(tree.map((p) => [p.path, p]));
  const components = new Map(); // ref -> component
  const edges = new Map(); // ref -> Set(ref)
  const refOf = (name, version) => purl(name, version);

  for (const pkg of tree) {
    const ref = refOf(pkg.name, pkg.version);
    components.set(ref, {
      type: "library",
      "bom-ref": ref,
      name: pkg.name,
      version: pkg.version,
      purl: ref,
      properties: [{ name: "pnpm:workspace", value: "true" }],
    });
  }
  const visit = (node, ownerRef, seenPaths) => {
    for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, dep] of Object.entries(node[group] ?? {})) {
        let ref;
        if (typeof dep.version === "string" && dep.version.startsWith("link:")) {
          const ws = workspaceByPath.get(dep.path);
          if (!ws) continue;
          ref = refOf(ws.name, ws.version);
        } else {
          ref = refOf(name, dep.version);
          if (!components.has(ref)) {
            const c = { type: "library", "bom-ref": ref, name, version: dep.version, purl: ref };
            const lic = licenseEntries(licenses[`${name}@${dep.version}`]);
            if (lic) c.licenses = lic;
            if (dep.resolved) c.externalReferences = [{ type: "distribution", url: dep.resolved }];
            components.set(ref, c);
          }
        }
        if (!edges.has(ownerRef)) edges.set(ownerRef, new Set());
        edges.get(ownerRef).add(ref);
        if (!dep.deduped && !seenPaths.has(dep.path) && !String(dep.version).startsWith("link:")) {
          seenPaths.add(dep.path);
          visit(dep, ref, seenPaths);
        }
      }
    }
  };
  for (const pkg of tree) visit(pkg, refOf(pkg.name, pkg.version), new Set());

  const sorted = [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  const rootPkg = tree[0];
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber,
    version: 1,
    metadata: {
      timestamp,
      tools: { components: [{ type: "application", name: "scripts/sbom.mjs", version: "1" }] },
      component: rootPkg
        ? {
            type: "application",
            "bom-ref": refOf(rootPkg.name, rootPkg.version),
            name: rootPkg.name ?? rootName,
            version: rootPkg.version,
          }
        : { type: "application", name: rootName },
    },
    components: sorted.filter(
      (c) => !rootPkg || c["bom-ref"] !== refOf(rootPkg.name, rootPkg.version),
    ),
    dependencies: sorted.map((c) => ({
      ref: c["bom-ref"],
      dependsOn: [...(edges.get(c["bom-ref"]) ?? [])].sort(),
    })),
  };
}

export function generate(root, out) {
  const tree = pnpmJson(["list", "-r", "--json", "--depth", "Infinity"], root);
  const lic = {};
  const byLicense = pnpmJson(["-r", "licenses", "list", "--json"], root);
  for (const [license, pkgs] of Object.entries(byLicense)) {
    for (const p of pkgs) for (const v of p.versions ?? []) lic[`${p.name}@${v}`] = license;
  }
  const sbom = buildSbom({
    tree,
    licenses: lic,
    rootName: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`);
  return sbom;
}

export function main(argv) {
  const arg = (n, d) => (argv.includes(n) ? resolve(argv[argv.indexOf(n) + 1]) : d);
  const root = arg("--root", join(dirname(fileURLToPath(import.meta.url)), ".."));
  const out = arg("--out", join(root, "dist", "sbom.cdx.json"));
  const sbom = generate(root, out);
  console.log(
    `sbom: ${sbom.components.length} components -> ${relative(process.cwd(), out) || out}`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exit(main(process.argv.slice(2)));
