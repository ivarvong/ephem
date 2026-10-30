#!/bin/bash
# Deploy ephem (and ephem-tail) from a committed revision only: never from the shared working tree.
#   scripts/deploy.sh <rev> "<message>" [auto|ephem|tail|all]     (DRY=1 runs the gate in the clean worktree and stops)
# Checks out <rev> into a throwaway git worktree, links node_modules from the main checkout (no npm install), runs the full
# gate there, then deploys from that worktree:
#   tail   ephem-tail (packages/tail) first: cf deploy, then (after ephem's smoke has sent it traffic) scripts/obs/tail-check.py
#          must see its invocations ok and the smoke's route labels; otherwise ephem-tail is rolled back.
#   ephem  gradual: upload a version (cf workers versions create), route it 0% next to the current version at 100%, smoke it
#          pinned (Cloudflare-Workers-Version-Overrides; x-ephem-version proves which version answered), promote to 100%,
#          wait until /healthz answers from it, smoke again. Any smoke failure is retried once (only the failed checks, after
#          RETRY_S s); still failing → route 100% back to the recorded previous version, re-smoke it, exit 1, no tag.
#          A change to non-versioned settings (tailConsumers, observability, logpush in packages/worker/cloudflare.config.ts)
#          deploys with cf deploy instead (no 0% stage: those settings apply on deployment), with the same live smoke + rollback.
# auto (default) = ephem, plus tail first when packages/tail, the shared route list or the invocations schema changed since
# the last deployed-tail/ tag, or tailConsumers changed since the last deployed/ tag. Success tags deployed/<ts> (ephem) and
# deployed-tail/<ts> (tail). Smoke checks live in the deployed commit's scripts/smoke.sh. Fails closed at every step.
# The body is one function so bash parses the whole file before running it: editing deploy.sh can't break a running deploy.
main() {
set -euo pipefail
REV=${1:?usage: deploy.sh <rev> "<message>" [auto|ephem|tail|all]}; MSG=${2:?usage: deploy.sh <rev> "<message>"}; TARGET=${3:-auto}
case "$TARGET" in auto|ephem|tail|all) ;; *) echo "target must be auto|ephem|tail|all" >&2; exit 2 ;; esac
ROOT=${EPHEM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}; B=https://ephem.ivar.workers.dev; RETRY_S=${RETRY_S:-5}
SHA=$(git -C "$ROOT" rev-parse --short=12 "$REV")
# One deploy at a time, and never backwards: concurrent agents' deploys raced and an older commit replaced a newer one
# for ~2 min (2026-10-30). A rollback or A/B of an older commit needs ALLOW_OLDER=1.
LOCK="$(git -C "$ROOT" rev-parse --absolute-git-dir)/ephem-deploy.lock"
mkdir "$LOCK" 2>/dev/null || { echo "another deploy is running (lock $LOCK, held by $(cat "$LOCK/owner" 2>/dev/null)); wait and rebase" >&2; exit 1; }
echo "$SHA pid $$ $(date -u +%FT%TZ)" > "$LOCK/owner"
WT=""; cleanup() { [ -n "$WT" ] && git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$LOCK"; }
trap cleanup EXIT
LAST=$(git -C "$ROOT" tag --list 'deployed/*' --sort=-refname | head -1)
LAST_TAIL=$(git -C "$ROOT" tag --list 'deployed-tail/*' --sort=-refname | head -1)
older() { [ -n "$1" ] && [ "${ALLOW_OLDER:-}" != 1 ] && ! git -C "$ROOT" merge-base --is-ancestor "$1" "$SHA"; }
changed() { [ -z "$1" ] || ! git -C "$ROOT" diff --quiet "$1" "$SHA" -- "${@:2}"; }
tc_changed() { [ -n "$LAST" ] && git -C "$ROOT" diff "$LAST" "$SHA" -- packages/worker/cloudflare.config.ts | grep -qE '^[+-][^+-].*tailConsumers'; }
DO_TAIL=0; DO_EPHEM=0
case "$TARGET" in
  ephem) DO_EPHEM=1 ;; tail) DO_TAIL=1 ;; all) DO_TAIL=1; DO_EPHEM=1 ;;
  auto) DO_EPHEM=1; { changed "$LAST_TAIL" packages/tail packages/worker/src/routes.ts packages/worker/ops/basin/invocations.schema.json || tc_changed; } && DO_TAIL=1 ;;
esac
for t in $([ $DO_EPHEM = 1 ] && echo "$LAST") $([ $DO_TAIL = 1 ] && echo "$LAST_TAIL"); do
  older "$t" && { echo "$SHA does not contain the last deployed commit ($t = $(git -C "$ROOT" rev-parse --short=12 "$t")): rebase onto main, or ALLOW_OLDER=1 for a rollback" >&2; exit 1; }
done
echo "== targets @ $SHA: $([ $DO_TAIL = 1 ] && echo "ephem-tail ")$([ $DO_EPHEM = 1 ] && echo ephem)"

WT=$(mktemp -d "${TMPDIR:-/tmp}/ephem-deploy-$SHA-XXXX")
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
[ -x "$WT/scripts/smoke.sh" ] || [ -f "$WT/scripts/smoke.sh" ] || { echo "$SHA has no scripts/smoke.sh" >&2; exit 1; }
[ "${DRY:-}" = 1 ] && { echo "== DRY=1: gate passed @ $SHA, not deploying"; exit 0; }

# --- helpers -------------------------------------------------------------------------------------------------------------
now() { python3 -c 'import time; print(f"{time.time():.1f}")'; }
since() { python3 -c "import sys,time; print(f'{time.time()-float(sys.argv[1]):.1f}')" "$1"; }
# active <worker>: the version id serving 100%, or "" if the current deployment is split
active() { cf workers deployments list --worker "$1" --per-page 1 | python3 -c 'import json,sys; v=json.load(sys.stdin)["deployments"][0]["versions"]; print(v[0]["version_id"] if len(v)==1 and v[0]["percentage"]==100 else "")'; }
# route <worker> <message> <id>:<pct> [<id>:<pct>]: create a deployment with these versions
route() {
  local w=$1 m=$2; shift 2
  local vs; vs=$(python3 -c 'import json,sys; print(json.dumps([{"version_id":a.split(":")[0],"percentage":int(a.split(":")[1])} for a in sys.argv[1:]]))' "$@")
  cf workers deployments create --worker "$w" --body "$(python3 -c 'import json,sys; print(json.dumps({"strategy":"percentage","versions":json.loads(sys.argv[1]),"annotations":{"workers/message":sys.argv[2]}}))' "$vs" "$m")" >/dev/null
}
# serving <id> <timeout-s> [pin]: wait until 5 consecutive /healthz answers come from <id> (pinned or not); prints seconds
serving() {
  local id=$1 to=$2 pin=${3:-} t0 ok=0 v h=()
  [ -n "$pin" ] && h=(-H "cloudflare-workers-version-overrides: ephem=\"$id\"")
  t0=$(now)
  while :; do
    v=$(curl -s -o /dev/null -D - --max-time 10 ${h[@]+"${h[@]}"} "$B/healthz" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-ephem-version"{print $2}')
    if [ "$v" = "$id" ]; then ok=$((ok + 1)); [ $ok -ge 5 ] && { since "$t0"; return 0; }; else ok=0; fi
    [ "$(python3 -c "import sys,time; print(int(time.time()-float(sys.argv[1]) > float(sys.argv[2])))" "$t0" "$to")" = 1 ] && { since "$t0"; return 1; }
    sleep 0.5
  done
}
# smoke_twice <label> <smoke args...>: run the deployed commit's smoke; retry only the failed checks once after RETRY_S s
smoke_twice() {
  local label=$1; shift; local f="$WT/.smoke-failed"
  echo "== smoke ($label)"
  bash "$WT/scripts/smoke.sh" "$B" "$@" --failed-to "$f" && return 0
  echo "== smoke ($label): retrying $(paste -sd, "$f") once in ${RETRY_S}s (flake check)"
  sleep "$RETRY_S"
  bash "$WT/scripts/smoke.sh" "$B" "$@" --only "$(paste -sd, "$f")"
}

# --- ephem-tail ------------------------------------------------------------------------------------------------------------
TAIL_NEW=""; TAIL_PREV=""
if [ $DO_TAIL = 1 ]; then
  TAIL_PREV=$(active ephem-tail)
  [ -n "$TAIL_PREV" ] || { echo "ephem-tail has a split deployment; resolve it first" >&2; exit 1; }
  echo "== deploy ephem-tail @ $SHA (previous $TAIL_PREV)"
  cd "$WT/packages/tail"
  out=$(cf deploy --message "$MSG [git $SHA]" 2>&1) || { echo "$out" | tail -20 >&2; echo "ephem-tail deploy failed" >&2; exit 1; }
  TAIL_NEW=$(echo "$out" | sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$TAIL_NEW" ] || { echo "$out" | tail -20 >&2; echo "ephem-tail deploy: no version id in the output" >&2; exit 1; }
  echo "ephem-tail $TAIL_NEW"
fi
tail_verify() {   # after ephem traffic (the smoke): the new tail ran ok and labelled the smoke's routes; else roll it back
  [ -n "$TAIL_NEW" ] || return 0
  echo "== tail check ($TAIL_NEW)"
  if python3 -I "$WT/scripts/obs/tail-check.py" --version "$TAIL_NEW" --minutes 5 --wait 150 --require /v1/track,/v1/sightline,/v1/alignment/search,/llms.txt,/docs/interactive; then
    git -C "$ROOT" tag -f "deployed-tail/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null; echo "== deployed ephem-tail $SHA ($TAIL_NEW)"; return 0
  fi
  route ephem-tail "rollback: tail check failed for $TAIL_NEW [git $SHA]" "$TAIL_PREV:100"
  echo "TAIL CHECK FAILED: ephem-tail rolled back to $TAIL_PREV" >&2; return 1
}
if [ $DO_EPHEM = 0 ]; then
  bash "$WT/scripts/smoke.sh" "$B" >/dev/null || true   # traffic for the tail check; ephem itself is unchanged
  tail_verify; exit $?
fi

# --- ephem -----------------------------------------------------------------------------------------------------------------
PREV=$(active ephem)
[ -n "$PREV" ] || { echo "ephem has a split deployment (a canary or rollout in progress); resolve it first" >&2; exit 1; }
cd "$WT/packages/worker"
MODE=gradual
if [ "${GRADUAL:-1}" = 0 ] || { [ -n "$LAST" ] && git -C "$ROOT" diff "$LAST" "$SHA" -- packages/worker/cloudflare.config.ts | grep -qE '^[+-][^+-].*(tailConsumers|observability|logpush)'; }; then MODE=direct; fi
echo "== deploy ephem @ $SHA ($MODE; previous $PREV)"
if [ $MODE = gradual ]; then
  out=$(cf workers versions create --message "$MSG [git $SHA]" 2>&1) || { echo "$out" | tail -20 >&2; echo "version upload failed" >&2; exit 1; }
  NEW=$(echo "$out" | sed -n 's/.*Worker Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$NEW" ] || { echo "$out" | tail -20 >&2; echo "version upload: no version id in the output" >&2; exit 1; }
  echo "$out" | grep -E 'Startup Time|Total Upload' || true
  echo "uploaded $NEW; routing it 0% (canary) beside $PREV 100%"
  route ephem "canary 0%: $MSG [git $SHA]" "$NEW:0" "$PREV:100"
  s=$(serving "$NEW" 60 pin) || { route ephem "canary abandoned: pin never reached $NEW [git $SHA]" "$PREV:100"; echo "CANARY FAILED: a pinned request never reached $NEW in ${s}s; removed it (prod stayed on $PREV)" >&2; exit 1; }
  echo "pinned requests reach $NEW after ${s}s"
  if ! smoke_twice "canary, pinned $NEW" --pin "$NEW"; then
    route ephem "canary failed: $MSG [git $SHA]" "$PREV:100"
    echo "CANARY SMOKE FAILED on $NEW (twice): prod never served it; removed it from the deployment (100% $PREV)" >&2; exit 1
  fi
  T0=$(now); route ephem "$MSG [git $SHA]" "$NEW:100"; echo "promoted $NEW to 100% ($(since "$T0")s)"
else
  T0=$(now)
  out=$(cf deploy --message "$MSG [git $SHA]" 2>&1) || { echo "$out" | tail -20 >&2; echo "deploy failed" >&2; exit 1; }
  NEW=$(echo "$out" | sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$NEW" ] || { echo "$out" | tail -20 >&2; echo "deploy: no version id in the output" >&2; exit 1; }
  echo "$out" | grep -E 'Startup Time' || true
fi
# Wait for the new version to serve, not a fixed sleep: /healthz from $NEW five times in a row (the old 5 s sleep did not
# guarantee it). A version that never serves counts as a failed smoke.
LIVE_OK=1
if s=$(serving "$NEW" 60); then echo "$NEW serving all of 5 consecutive /healthz ${s}s after promotion"; else echo "FAIL $NEW not serving after ${s}s"; LIVE_OK=0; fi
[ $LIVE_OK = 1 ] && { smoke_twice "live" --expect "$NEW" || LIVE_OK=0; }
if [ $LIVE_OK = 0 ]; then
  TR=$(now); route ephem "rollback: smoke failed for $NEW [git $SHA]" "$PREV:100"
  echo "ROLLBACK: deployment back to $PREV created in $(since "$TR")s"
  s=$(serving "$PREV" 60) && echo "ROLLBACK: $PREV serving 5 consecutive /healthz ${s}s after the rollback deployment ($(since "$TR")s after the decision)" || echo "ROLLBACK: $PREV still not serving after ${s}s" >&2
  bash "$WT/scripts/smoke.sh" "$B" --expect "$PREV" | tail -1 || true
  echo "SMOKE FAILED on $NEW (twice): rolled back to $PREV. Not tagged." >&2; exit 1
fi
git -C "$ROOT" tag -f "deployed/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null
echo "== deployed ephem $SHA ($NEW)"
tail_verify
}
main "$@"
