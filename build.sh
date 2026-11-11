#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node -e 'if(Number(process.versions.node.split(".")[0])<25)throw Error("Node 25+ required")'
for project in work/ecosystem/brokkr work/ecosystem/mimir work/ecosystem/sindri outputs/heimdall; do
  (cd "$root/$project" && pnpm install --frozen-lockfile && pnpm build)
done
# Skidbladnir is optional and the launcher does not load it: a failure here leaves the factory usable.
if ! (cd "$root/outputs/skidbladnir" && npm ci && npm run build); then
  printf 'The factory is built; Start outputs/local-factory/Start Factory.command\nSkidbladnir (optional, not used by the launcher) failed to build. See the errors above.\n' >&2
  exit 2
fi
printf 'Build complete. Start outputs/local-factory/Start Factory.command\n'
