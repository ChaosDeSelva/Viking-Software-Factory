import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require=createRequire(import.meta.url);
const sections=['Skidbladnir production dashboard — third-party notices'];
for(const name of ['react','react-dom','scheduler']) {
 const path=dirname(require.resolve(name+'/package.json'));
 const pkg=JSON.parse(readFileSync(resolve(path,'package.json'),'utf8'));
 sections.push(`${name} ${pkg.version}\n\n${readFileSync(resolve(path,'LICENSE'),'utf8')}`);
}
writeFileSync(new URL('../dist/THIRD-PARTY-NOTICES.txt',import.meta.url),sections.join('\n\n--------------------\n\n'));
