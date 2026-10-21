#!/usr/bin/env python3
"""Build an installable local bundle. Run on the target architecture, never on user data."""
import argparse,hashlib,json,os,shutil,stat,subprocess,tempfile,zipfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--version',default='0.2.0');p.add_argument('--skip-build',action='store_true');p.add_argument('--bifrost',type=Path);p.add_argument('--hulder',type=Path);p.add_argument('--companion',type=Path);args=p.parse_args()
root=args.source.resolve();out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
def run(cmd,cwd):subprocess.run(cmd,cwd=cwd,check=True)
def copy(src,dst):
 if src.is_dir():shutil.copytree(src,dst,symlinks=True,ignore=shutil.ignore_patterns('.git','.data','.heimdall','test-results','coverage','.DS_Store'))
 else:dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst)
with tempfile.TemporaryDirectory(prefix='viking-package-') as temp:
 stage=Path(temp);core=stage/'core';core.mkdir()
 if not args.skip_build:run(['sh','build.sh'],root)
 copy(Path(shutil.which('node')).resolve(),core/'node')
 for name in ['mimir','sindri','brokkr']:
  source=root/'work/ecosystem'/name;target=core/'work/ecosystem'/name
  apps=['server','cli'] if name!='brokkr' else ['cli']
  for app in apps:
   run(['pnpm','--filter',f'@{name}/{app}','deploy','--prod',str(target/'apps'/app)],source)
  if name!='brokkr':copy(source/'apps/web/dist',target/'apps/web/dist')
  if (source/'third_party').exists():copy(source/'third_party',target/'third_party')
  for f in ['LICENSE','NOTICE','README.md']:
   if (source/f).exists():copy(source/f,target/f)
 for item in ['apps/server','dist','LICENSE','NOTICE']:
  src=root/'outputs/heimdall'/item
  if src.exists():copy(src,core/'outputs/heimdall'/item)
 copy(root/'outputs/local-factory/factory.mjs',core/'outputs/local-factory/factory.mjs')
 legal=Path(__file__).resolve().parents[2]
 copy(legal/'LICENSE',core/'LICENSE');copy(legal/'NOTICE',core/'NOTICE')
 # Node runtime license travels with the runtime; packaging fails rather than inventing a notice.
 node_prefix=Path(shutil.which('node')).resolve().parent.parent
 copy(node_prefix/'lib/node_modules/npm',core/'npm-runtime')
 (core/'npm').symlink_to('npm-runtime/bin/npm-cli.js')
 (core/'npx').symlink_to('npm-runtime/bin/npx-cli.js')
 node_license=next((f for f in [node_prefix/'LICENSE',node_prefix/'share/doc/node/LICENSE'] if f.exists()),None)
 if node_license:copy(node_license,core/'NODE-LICENSE')
 else:raise SystemExit('Node license not found. Use an official Node distribution with its LICENSE file.')
 skid=stage/'skidbladnir'
 for item in ['apps/api','packages','dist','infra','package.json','package-lock.json','LICENSE','NOTICE']:
  src=root/'outputs/skidbladnir'/item
  if src.exists():copy(src,skid/item)
 run(['npm','ci','--omit=dev','--ignore-scripts'],skid)
 if args.bifrost:
  copy(args.bifrost.resolve(),stage/'bifrost/bifrost')
  for name in ['LICENSE','NOTICE']:copy(legal.parent/'bifrost'/name,stage/'bifrost'/name)
 if args.hulder:copy(args.hulder.resolve(),stage/'hulder/Hulder.app')
 if args.companion:copy(args.companion.resolve(),stage/'companion/Viking Factory.app')
 manifest={'schema':1,'version':args.version,'channel':'preview','platform':'macos-arm64','data_schema':1,'packages':[]}
 for component in sorted(stage.iterdir()):
  archive=out/f'{component.name}-{args.version}-macos-arm64.zip'
  with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6,strict_timestamps=False) as z:
   for parent,dirs,files in os.walk(component,followlinks=False):
    for name in dirs+files:
     f=Path(parent)/name;rel=str(f.relative_to(component))
     if f.is_symlink():
      info=zipfile.ZipInfo(rel);info.create_system=3;info.external_attr=(stat.S_IFLNK|0o777)<<16
      z.writestr(info,os.readlink(f))
     elif f.is_file():z.write(f,rel)
  manifest['packages'].append({'id':component.name,'version':args.version,'archive':archive.name,'sha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'required':component.name in ['core','companion']})
 (out/'factory-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 print(json.dumps(manifest,indent=2))
