#!/bin/bash
# Install the dependencies of the checked-out commit (npm ci) and restore the per-package wrangler links cf needs, which
# every npm install / npm ci removes (docs/telemetry_and_profiling.md "Gotchas"). The one way to update node_modules in the
# shared tree: run it after pulling a commit that changes package-lock.json (deploy.sh installs a changed lockfile for its own
# worktree by itself, cached by lockfile hash).
#   scripts/install-deps.sh
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci --no-audit --no-fund --loglevel=error
for p in worker tail load; do
  mkdir -p "packages/$p/node_modules/.bin"
  ln -sfn "$PWD/node_modules/wrangler" "packages/$p/node_modules/wrangler"
  ln -sfn "$PWD/node_modules/.bin/wrangler" "packages/$p/node_modules/.bin/wrangler"
done
node --experimental-strip-types scripts/build-web.ts
echo "deps installed ($(shasum -a 256 package-lock.json | cut -c1-16)); wrangler linked into packages/{worker,tail,load}; web built"
