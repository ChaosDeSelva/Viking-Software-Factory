#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node -e 'if(Number(process.versions.node.split(".")[0])<25)throw Error("Node 25+ required")'
for project in work/ecosystem/brokkr work/ecosystem/mimir work/ecosystem/sindri outputs/heimdall; do
  (cd "$root/$project" && pnpm install --frozen-lockfile && pnpm build)
done
(cd "$root/outputs/skidbladnir" && npm ci && npm run build)
printf 'Build complete. Start outputs/local-factory/Start Factory.command\n'
