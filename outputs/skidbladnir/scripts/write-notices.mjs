import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Every package bundled into dist: React plus @factory/ui and @factory/docs with their runtime
// dependency trees (peer dependencies such as react are listed once at the top).
const roots = ['react', 'react-dom', 'scheduler', '@factory/ui', '@factory/docs'];
const seen = new Map();
// Node-style lookup through ancestor node_modules (many packages do not export ./package.json).
function locate(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = resolve(dir, 'node_modules', name);
    if (existsSync(resolve(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}
function visit(name, fromDir) {
  const path = locate(name, fromDir);
  if (!path) return;
  const pkg = JSON.parse(readFileSync(resolve(path, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) return;
  seen.set(key, { pkg, path });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, path);
}
for (const name of roots) visit(name, fileURLToPath(new URL('..', import.meta.url)));

const sections = ['Skidbladnir production dashboard — third-party notices'];
for (const [key, { pkg, path }] of seen) {
  const file = readdirSync(path).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f));
  const text =
    file && existsSync(resolve(path, file))
      ? readFileSync(resolve(path, file), 'utf8')
      : `License: ${pkg.license ?? 'see package'}`;
  sections.push(`${key}\n\n${text}`);
}
writeFileSync(
  new URL('../dist/THIRD-PARTY-NOTICES.txt', import.meta.url),
  sections.join('\n\n--------------------\n\n'),
);
