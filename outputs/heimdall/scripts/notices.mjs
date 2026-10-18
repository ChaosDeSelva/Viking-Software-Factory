import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))), store=join(root,'node_modules/.pnpm');
const notices=[];
function inspect(path) {
  if(!existsSync(join(path,'package.json')))return;
  const pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));
  const texts=readdirSync(path).filter(n=>/^(licen[cs]e|copying|notice)(\.|$)/i.test(n)).flatMap(n=>{
    try{return [`${n}\n${readFileSync(join(path,n),'utf8')}`];}catch{return [];}
  });
  if(texts.length)notices.push({name:pkg.name,version:pkg.version,license:pkg.license??'See text',text:texts.join('\n\n')});
}
for(const dir of readdirSync(store)) {
  const node=join(store,dir,'node_modules');if(!existsSync(node))continue;
  for(const name of readdirSync(node)) {
    if(name.startsWith('@'))for(const child of readdirSync(join(node,name)))inspect(join(node,name,child));
    else inspect(join(node,name));
  }
}
const unique=[...new Map(notices.map(n=>[n.name+'@'+n.version,n])).values()].sort((a,b)=>a.name.localeCompare(b.name));
mkdirSync(join(root,'third_party'),{recursive:true});
writeFileSync(join(root,'third_party/DEPENDENCY_NOTICES.txt'),'Installed build and runtime dependency license notices. Inclusion does not imply every package is shipped at runtime.\n\n'+unique.map(n=>`${n.name}@${n.version} (${n.license})\n${n.text}`).join('\n\n--------------------\n\n'));
console.log(`Recorded ${unique.length} dependency notices`);
