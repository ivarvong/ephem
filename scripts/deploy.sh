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
# One deploy at a time, and never backwards: concurrent agents' deploys raced and an older commit replaced a newer one
# for ~2 min (2026-10-30). A rollback or A/B of an older commit needs ALLOW_OLDER=1.
LOCK="$(git -C "$ROOT" rev-parse --absolute-git-dir)/ephem-deploy.lock"
mkdir "$LOCK" 2>/dev/null || { echo "another deploy is running (lock $LOCK, held by $(cat "$LOCK/owner" 2>/dev/null)); wait and rebase" >&2; exit 1; }
echo "$SHA pid $$ $(date -u +%FT%TZ)" > "$LOCK/owner"
LAST=$(git -C "$ROOT" tag --list 'deployed/*' --sort=-refname | head -1)
if [ -n "$LAST" ] && [ "${ALLOW_OLDER:-}" != 1 ] && ! git -C "$ROOT" merge-base --is-ancestor "$LAST" "$SHA"; then
  rm -rf "$LOCK"; echo "$SHA does not contain the last deployed commit ($LAST = $(git -C "$ROOT" rev-parse --short=12 "$LAST")): rebase onto main, or ALLOW_OLDER=1 for a rollback" >&2; exit 1
fi
WT=$(mktemp -d "${TMPDIR:-/tmp}/ephem-deploy-$SHA-XXXX")
cleanup() { git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$LOCK"; }
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
# One command per line: a failure inside an && list does not trip `set -e`, so `typecheck && lint && test` passed the gate
# with a failing typecheck and skipped lint and tests (found 2026-10-30, 3c87955).
npm run typecheck >/dev/null || { echo "GATE FAILED: typecheck" >&2; exit 1; }
npm run lint >/dev/null || { echo "GATE FAILED: lint" >&2; exit 1; }
npm test > "$WT/.test.log" 2>&1 || { tail -40 "$WT/.test.log" >&2; echo "GATE FAILED: tests" >&2; exit 1; }
grep -E 'Test Files|Tests ' "$WT/.test.log"

[ "${DRY:-}" = 1 ] && { echo "== DRY=1: gate passed @ $SHA, not deploying"; exit 0; }
echo "== deploy @ $SHA"
cd "$WT/packages/worker"
cf deploy --message "$MSG [git $SHA]" 2>&1 | grep -E 'Current Version ID|Startup Time|error|Error' || { echo "deploy failed" >&2; exit 1; }

echo "== smoke"
sleep 5
T=$(date -u +%Y-%m-%dT%H:%M:%SZ); fail=0
for p in "/" "/docs" "/docs/interactive" "/llms.txt" "/openapi.json" "/v1/position?lat=40.7&lon=-74" "/v1/position?lat=40.7&lon=-74&time=$T" \
         "/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York" "/v1/magnetic?lat=40.7&lon=-74" \
         "/v1/crossing?lat=40.7&lon=-74&body=sun&altitude=-0.8333&direction=set&date=2026-10-29&tz=America/New_York" \
         "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-29T02:00:00Z&end=2026-10-29T03:00:00Z" \
         "/v1/track?lat=40.7&lon=-74&start=2026-10-29T00:00:00Z&end=2026-10-30T00:00:00Z" \
         "/v1/weather?lat=40.7&lon=-74"; do
  c=$(curl -s -o /dev/null -w "%{http_code}" "$B$p"); echo "$c $p"; [ "$c" = 200 ] || fail=1
done
# /docs must be useful without JS (links the spec) and /llms.txt must name the MCP endpoint (round-2 #7)
curl -s "$B/docs" | grep -q 'href="/openapi.json"' && echo "ok  /docs links /openapi.json (no JS)" || { echo "FAIL /docs has no /openapi.json link"; fail=1; }
curl -s "$B/llms.txt" | grep -q "$B/mcp" && echo "ok  /llms.txt names the MCP endpoint" || { echo "FAIL /llms.txt"; fail=1; }
c=$(curl -s -o /dev/null -w "%{http_code}" "$B/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York&bogus=1"); echo "$c unknown-param (want 400)"; [ "$c" = 400 ] || fail=1
# POST /v1/alignment/search: the customer's Nov 16 2026 pass over a bbox of Brooklyn Bridge Park (fans out to a cached window GET)
S=$(curl -s -w "\n%{http_code}" -X POST -H 'content-type: application/json' "$B/v1/alignment/search" \
  -d '{"body":"moon","target":{"lat":40.68925,"lon":-74.0445,"height":70,"heightRef":"msl"},"region":[-73.9995,40.7,-73.993,40.706],"observerHeight":5,"heightRef":"msl","start":"2026-11-16T00:00:00Z","end":"2026-11-18T00:00:00Z"}')
c=$(echo "$S" | tail -1); echo "$S" | head -1 | grep -q '"enter":{"time":"2026-11-17T03:4' || c="$c (no Nov 17 03:4x entry)"; echo "$c POST /v1/alignment/search"; [ "$c" = 200 ] || fail=1
cd "$WT" && node --experimental-strip-types scripts/obs/mcp-probe.ts "$B" | tail -1
[ $fail = 0 ] || { echo "SMOKE FAILED: roll back with cf (cf cli search \"rollback worker deployment\")" >&2; exit 1; }
git -C "$ROOT" tag -f "deployed/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null
echo "== deployed $SHA"
