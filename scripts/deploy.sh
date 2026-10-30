#!/bin/bash
# Deploy ephem from a committed revision only: never from the shared working tree.
#   scripts/deploy.sh <rev> "<message>"      (DRY=1 runs the gate in the clean worktree and stops)
# Checks out <rev> into a throwaway git worktree, links node_modules from the main checkout (no npm install),
# runs the full gate there, deploys with cf (message carries the sha), then smokes prod and runs the MCP probe.
# Anything uncommitted in the shared tree cannot ship. Fails closed at every step.
set -euo pipefail
REV=${1:?usage: deploy.sh <rev> "<message>"}; MSG=${2:?usage: deploy.sh <rev> "<message>"}
ROOT=$(cd "$(dirname "$0")/.." && pwd); B=https://ephem.ivar.workers.dev
SHA=$(git -C "$ROOT" rev-parse --short=12 "$REV")
WT=$(mktemp -d "${TMPDIR:-/tmp}/ephem-deploy-$SHA-XXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$ROOT" worktree add --detach -q "$WT" "$SHA"
# node_modules: link every package from the main checkout EXCEPT the workspace packages (@ephem/*). Those are relative
# symlinks (../../packages/core), so linking the whole directory resolved @ephem/core and @ephem/api to the shared tree's
# uncommitted files (found 2026-10-30); here they point at this worktree's packages.
mkdir "$WT/node_modules"
for e in "$ROOT"/node_modules/* "$ROOT"/node_modules/.[!.]*; do
  [ -e "$e" ] || continue; n=$(basename "$e"); [ "$n" = "@ephem" ] && continue
  ln -s "$e" "$WT/node_modules/$n"
done
mkdir "$WT/node_modules/@ephem"
for e in "$ROOT"/node_modules/@ephem/*; do n=$(basename "$e"); ln -s "$WT/packages/$n" "$WT/node_modules/@ephem/$n"; done
for p in "$ROOT"/packages/*/; do
  n=$(basename "$p"); [ -d "$p/node_modules" ] || continue
  mkdir -p "$WT/packages/$n/node_modules/.bin"
  for e in "$p"/node_modules/*; do [ -e "$e" ] && ln -s "$(readlink -f "$e")" "$WT/packages/$n/node_modules/$(basename "$e")"; done
  [ -e "$ROOT/node_modules/.bin/wrangler" ] && ln -sf "$ROOT/node_modules/.bin/wrangler" "$WT/packages/$n/node_modules/.bin/wrangler"
done
# untracked-but-needed test inputs (gitignored binaries) come from the main checkout
for d in data/jpl reference/terrain_sunset/inputs reference/geoid/inputs; do
  [ -d "$ROOT/$d" ] && { mkdir -p "$WT/$(dirname "$d")"; rm -rf "$WT/$d"; ln -s "$ROOT/$d" "$WT/$d"; }
done

echo "== gate @ $SHA"
cd "$WT"
npm run typecheck >/dev/null && npm run lint >/dev/null && npm test 2>&1 | grep -E 'Test Files|Tests '

[ "${DRY:-}" = 1 ] && { echo "== DRY=1: gate passed @ $SHA, not deploying"; exit 0; }
echo "== deploy @ $SHA"
cd "$WT/packages/worker"
cf deploy --message "$MSG [git $SHA]" 2>&1 | grep -E 'Current Version ID|Startup Time|error|Error' || { echo "deploy failed" >&2; exit 1; }

echo "== smoke"
sleep 5
T=$(date -u +%Y-%m-%dT%H:%M:%SZ); fail=0
for p in "/" "/docs" "/openapi.json" "/v1/position?lat=40.7&lon=-74" "/v1/position?lat=40.7&lon=-74&time=$T" \
         "/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York" "/v1/magnetic?lat=40.7&lon=-74" \
         "/v1/crossing?lat=40.7&lon=-74&body=sun&altitude=-0.8333&direction=set&date=2026-10-29&tz=America/New_York" \
         "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-29T02:00:00Z&end=2026-10-29T03:00:00Z" \
         "/v1/track?lat=40.7&lon=-74&start=2026-10-29T00:00:00Z&end=2026-10-30T00:00:00Z" \
         "/v1/weather?lat=40.7&lon=-74"; do
  c=$(curl -s -o /dev/null -w "%{http_code}" "$B$p"); echo "$c $p"; [ "$c" = 200 ] || fail=1
done
c=$(curl -s -o /dev/null -w "%{http_code}" "$B/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York&bogus=1"); echo "$c unknown-param (want 400)"; [ "$c" = 400 ] || fail=1
cd "$WT" && node --experimental-strip-types scripts/obs/mcp-probe.ts "$B" | tail -1
[ $fail = 0 ] || { echo "SMOKE FAILED: roll back with cf (cf cli search \"rollback worker deployment\")" >&2; exit 1; }
git -C "$ROOT" tag -f "deployed/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null
echo "== deployed $SHA"
