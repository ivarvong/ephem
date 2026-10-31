#!/bin/bash
# Deploy ephem (and ephem-tail, ephem-load) from a committed revision only: never from the shared working tree.
#   scripts/deploy.sh <rev> "<message>" [auto|ephem|tail|load|all]     (DRY=1 runs the gate in the clean worktree and stops)
# Checks out <rev> into a throwaway git worktree, links node_modules from the main checkout (no npm install), runs the full
# gate there, then deploys from that worktree:
#   tail   ephem-tail (packages/tail) first: cf deploy, then (after ephem's smoke has sent it traffic) scripts/obs/tail-check.py
#          must see its invocations ok and the smoke's route labels; otherwise ephem-tail is rolled back.
#   ephem  gradual: upload a version (cf workers versions create, in parallel with the gate: an uploaded version is in no
#          deployment, so nothing reaches it), route it 0% next to the current version at 100% only after the gate passed,
#          smoke it pinned (Cloudflare-Workers-Version-Overrides; x-ephem-version proves which version answered; checks run
#          concurrently), telemetry gate (early pass), promote to 100%, wait until /healthz answers from it, smoke again.
#          Any smoke failure is retried once (only the failed checks, after RETRY_S s); still failing → route 100% back to
#          the recorded previous version, re-smoke it, exit 1, no tag. The deploy is done (tagged deployed/<ts>) after the
#          live smoke; a detached live watcher (EPHEM_DEPLOY_LIVE=1, lock .git/ephem-live.lock, log .git/ephem-live/) then
#          runs the live gate, the deferred full canary check and the tail check, and rolls back + untags on a failure. The
#          next deploy waits for its verdict before touching any deployment. LIVE_WAIT=1 keeps the watcher in the foreground.
#          Gate: typecheck, lint and tests in parallel; skipped when the same tree + node_modules already passed
#          (.git/ephem-gate-pass/; NO_GATE_CACHE=1 runs it anyway). One `== timings` line per deploy (stage durations).
#          A change to non-versioned settings (tailConsumers, observability, logpush in packages/worker/cloudflare.config.ts)
#          deploys with cf deploy instead (no 0% stage: those settings apply on deployment), with the same live smoke + rollback.
#   load   ephem-load (packages/load, the remote load generator; guide "Remote load"): cf deploy, wait until /health answers from
#          the new version, then check it: /health (target, limits), unauthenticated POST /run refused (401), and with the token
#          (~/.config/ephem-load/token) an over-limit /plan refused (400) and a 10-request run from one region answered by
#          ephem (scripts/obs/load-remote.ts). Any failure routes ephem-load back to its previous version. Tags deployed-load/<ts>.
#          It never touches ephem, so it runs (and can fail) before the ephem phase.
# auto (default) = ephem, plus tail first when packages/tail, the shared route list or the invocations schema changed since
# the last deployed-tail/ tag, or tailConsumers changed since the last deployed/ tag, plus load when packages/load changed
# since the last deployed-load/ tag. Success tags deployed/<ts> (ephem), deployed-tail/<ts> and deployed-load/<ts>. (ephem-compute, a separate Worker for Api + BlockStore, and its `compute` target were removed after the
# 2026-10-30 A/B, DESIGN §12.0; old deployed-compute/ tags are history.) Smoke checks live in the deployed commit's scripts/smoke.sh. Fails closed at every step.
# Telemetry gate (scripts/obs/canary-gate.py): after the pinned canary smoke and before promotion,
# the gate reads Workers Observability for exactly the smoke's requests (smoke.sh --run: x-ephem-smoke header; --manifest:
# their cf-rays) and fails on exceptions, 5xx, error logs, missing entrypoints/spans or missing telemetry; a failure removes
# the canary exactly like a failed smoke. It passes early (--early 0.75: 0 errors, every required span, 75% of the requests
# visible; O11Y_EARLY overrides) and the live watcher re-runs it in full. After promotion it runs again over the live smoke
# plus all real traffic for O11Y_LIVE_S (90) s: a new error signature rolls back. SKIP_O11Y_GATE=1 skips it (emergencies only).
#
# Two stages, so the deploy logic always comes from the commit being deployed, never from the shared tree (an agent's
# uncommitted deploy.sh ran another agent's deploy, 2026-10-30):
#   bootstrap  (this file, as found in the shared tree): take the lock, refuse to go backwards, `git worktree add` <rev>, then
#              exec <worktree>/scripts/deploy.sh with EPHEM_DEPLOY_INNER=1 and the lock + worktree paths. Same pid, so the
#              lock owner line stays true; the inner copy's EXIT trap releases the lock and removes the worktree on every
#              path. Keep it tiny: it is the only code that runs from the shared tree.
#   inner      main() below, from <rev>: node_modules links, gate, deploy, smokes, telemetry gate, rollback. Its smoke.sh and
#              scripts/obs/* are <rev>'s too. A <rev> from before the bootstrap (no EPHEM_DEPLOY_INNER in its deploy.sh) runs
#              its own deploy.sh whole (it takes the lock itself).
if [ "${EPHEM_DEPLOY_INNER:-}" != 1 ]; then
  set -euo pipefail
  REV=${1:?usage: deploy.sh <rev> "<message>" [auto|ephem|tail|load|all]}
  ROOT=${EPHEM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
  SHA=$(git -C "$ROOT" rev-parse --short=12 "$REV")
  LOCK="$(git -C "$ROOT" rev-parse --absolute-git-dir)/ephem-deploy.lock"
  mkdir "$LOCK" 2>/dev/null || { echo "another deploy is running (lock $LOCK, held by $(cat "$LOCK/owner" 2>/dev/null)); wait and rebase" >&2; exit 1; }
  echo "$SHA pid $$ $(date -u +%FT%TZ)" > "$LOCK/owner"
  WT=""; trap '[ -n "$WT" ] && git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$LOCK"' EXIT   # until exec
  LAST=$(git -C "$ROOT" tag --list 'deployed/*' --sort=-refname | head -1)
  if [ -n "$LAST" ] && [ "${ALLOW_OLDER:-}" != 1 ] && ! git -C "$ROOT" merge-base --is-ancestor "$LAST" "$SHA"; then
    echo "$SHA does not contain the last deployed commit ($LAST = $(git -C "$ROOT" rev-parse --short=12 "$LAST")): rebase onto main, or ALLOW_OLDER=1 for a rollback" >&2; exit 1
  fi
  WT=$(mktemp -d "${TMPDIR:-/tmp}/ephem-deploy-$SHA-XXXX")
  git -C "$ROOT" worktree add --detach -q "$WT" "$SHA"
  if ! grep -q 'EPHEM_DEPLOY_INNER' "$WT/scripts/deploy.sh"; then
    OLD=$(mktemp "${TMPDIR:-/tmp}/ephem-deploy-legacy-XXXX"); cp "$WT/scripts/deploy.sh" "$OLD"
    git -C "$ROOT" worktree remove --force "$WT"; WT=""; rm -rf "$LOCK"; trap - EXIT
    echo "== bootstrap: $SHA predates the two-stage deploy; running its own deploy.sh whole" >&2
    exec env EPHEM_ROOT="$ROOT" bash "$OLD" "$@"
  fi
  echo "== bootstrap: lock + worktree for $SHA; exec its own scripts/deploy.sh (sha256 $(shasum -a 256 "$WT/scripts/deploy.sh" | cut -c1-12); shared tree's $(shasum -a 256 "$0" | cut -c1-12))"
  exec env EPHEM_DEPLOY_INNER=1 EPHEM_DEPLOY_LOCK="$LOCK" EPHEM_DEPLOY_WT="$WT" EPHEM_ROOT="$ROOT" bash "$WT/scripts/deploy.sh" "$@"
fi
# --- inner: runs from the commit being deployed ----------------------------------------------------------------------------
# The body is one function so bash parses the whole file before running it.
main() {
set -euo pipefail
ROOT=${EPHEM_ROOT:?inner deploy.sh needs EPHEM_ROOT (the main checkout; set by the bootstrap)}
WT=${EPHEM_DEPLOY_WT:?inner deploy.sh needs EPHEM_DEPLOY_WT (run scripts/deploy.sh, not the inner copy)}
GITDIR=$(git -C "$ROOT" rev-parse --absolute-git-dir)
REV=${1:?usage: deploy.sh <rev> "<message>" [auto|ephem|tail|load|all]}; MSG=${2:?usage: deploy.sh <rev> "<message>"}; TARGET=${3:-auto}
case "$TARGET" in auto|ephem|tail|load|all) ;; *) echo "target must be auto|ephem|tail|load|all" >&2; exit 2 ;; esac
B=https://ephem.ivar.workers.dev; RETRY_S=${RETRY_S:-5}
SHA=$(git -C "$ROOT" rev-parse --short=12 "$REV")
LL="$GITDIR/ephem-live.lock"   # held by the live watcher (below) from promotion until its verdict
LIVEDIR="$GITDIR/ephem-live"; mkdir -p "$LIVEDIR"
LAST=$(git -C "$ROOT" tag --list 'deployed/*' --sort=-refname | head -1)
O11Y_LIVE_S=${O11Y_LIVE_S:-90}
HAS_GATE=0; [ -f "$WT/scripts/obs/canary-gate.py" ] && HAS_GATE=1

# --- helpers -------------------------------------------------------------------------------------------------------------
now() { python3 -c 'import time; print(f"{time.time():.1f}")'; }
since() { python3 -c "import sys,time; print(f'{time.time()-float(sys.argv[1]):.1f}')" "$1"; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
# stage <name>: close the running stage (its duration joins TIMINGS, printed as one `== timings` line)
TIMINGS=""; T_INNER=$(now); T_STAGE=$T_INNER
stage() { TIMINGS="$TIMINGS $1=$(since "$T_STAGE")"; T_STAGE=$(now); }
# exists <worker>: it has a deployment
exists() { cf workers deployments list --worker "$1" --per-page 1 >/dev/null 2>&1; }
# active <worker>: the version id serving 100%, or "" if the current deployment is split
active() { cf workers deployments list --worker "$1" --per-page 1 | python3 -c 'import json,sys; v=json.load(sys.stdin)["deployments"][0]["versions"]; print(v[0]["version_id"] if len(v)==1 and v[0]["percentage"]==100 else "")'; }
# route <worker> <message> <id>:<pct> [<id>:<pct>]: create a deployment with these versions
route() {
  local w=$1 m=$2; shift 2
  local vs; vs=$(python3 -c 'import json,sys; print(json.dumps([{"version_id":a.split(":")[0],"percentage":int(a.split(":")[1])} for a in sys.argv[1:]]))' "$@")
  cf workers deployments create --worker "$w" --body "$(python3 -c 'import json,sys; print(json.dumps({"strategy":"percentage","versions":json.loads(sys.argv[1]),"annotations":{"workers/message":sys.argv[2][:100]}}))' "$vs" "$m")" >/dev/null
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
    sleep 0.3
  done
}
# smoke_twice <label> <smoke args...>: run the deployed commit's smoke (its checks run concurrently); retry only the failed
# checks once after RETRY_S s
smoke_twice() {
  local label=$1; shift; local f="$WT/.smoke-failed-$label"
  echo "== smoke ($label)"
  bash "$WT/scripts/smoke.sh" "$B" "$@" --failed-to "$f" && return 0
  echo "== smoke ($label): retrying $(paste -sd, "$f") once in ${RETRY_S}s (flake check)"
  sleep "$RETRY_S"
  bash "$WT/scripts/smoke.sh" "$B" "$@" --only "$(paste -sd, "$f")"
}
# o11y_gate <worker> <new> <prev> <since-iso> <run> <manifest> [gate args]: the telemetry gate (prints its table)
o11y_gate() {
  if [ $HAS_GATE = 0 ]; then echo "!! $SHA predates the telemetry gate (no scripts/obs/canary-gate.py): gate skipped for $1 ${2:0:8}" >&2; return 0; fi
  if [ "${SKIP_O11Y_GATE:-}" = 1 ]; then
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    echo "!! SKIP_O11Y_GATE=1: the telemetry gate for $1 ${2:0:8} is SKIPPED. Emergencies only. Nothing read the canary's traces." >&2
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!" >&2
    return 0
  fi
  local w=$1 n=$2 p=$3 since=$4 run=$5 man=$6; shift 6
  local t0 rc=0; t0=$(now)
  python3 -I "$WT/scripts/obs/canary-gate.py" "$w" "$n" "${p:--}" --since "$since" --run "$run" --manifest "$man" --wait "${O11Y_WAIT_S:-90}" "$@" || rc=$?
  echo "== telemetry gate ($w ${n:0:8}${1:+ $*}): exit $rc after $(since "$t0")s"; return $rc
}
# gate_args <run> <manifest>: smoke.sh --run/--manifest, only when this commit's smoke.sh has them
gate_args() { [ $HAS_GATE = 1 ] && printf '%s\n' --run "$1" --manifest "$2"; return 0; }
notify() { osascript -e "display notification \"$(echo "$2" | tr -d '"\\' | cut -c1-200)\" with title \"$(echo "$1" | tr -d '"\\')\"" >/dev/null 2>&1 || true; }
# rollback_ephem <reason>: route 100% back to PREV, wait until it serves, re-smoke it with the last deployed commit's smoke.sh
rollback_ephem() {
  local TR s; TR=$(now); route ephem "rollback: $1 for ${NEW:0:8} [git $SHA]" "$PREV:100"
  echo "ROLLBACK: deployment back to $PREV created in $(since "$TR")s ($1)"
  s=$(serving "$PREV" 60) && echo "ROLLBACK: $PREV serving 5 consecutive /healthz ${s}s after the rollback deployment ($(since "$TR")s after the decision)" || echo "ROLLBACK: $PREV still not serving after ${s}s" >&2
  # re-smoke the restored version with the smoke of the commit it was deployed from (the failed commit's own checks may be
  # what failed); falls back to this commit's smoke
  local PREV_SMOKE="$WT/scripts/smoke.sh"
  [ -n "${PREV_TAG:-}" ] && git -C "$ROOT" show "$PREV_TAG:scripts/smoke.sh" > "$WT/scripts/.smoke-prev.sh" 2>/dev/null && PREV_SMOKE="$WT/scripts/.smoke-prev.sh"
  echo "ROLLBACK: re-smoke of $PREV ($([ "$PREV_SMOKE" = "$WT/scripts/smoke.sh" ] && echo "this commit's" || echo "$PREV_TAG's") smoke.sh): $(bash "$PREV_SMOKE" "$B" --expect "$PREV" 2>&1 | tail -1)"
}
tail_verify() {   # after ephem traffic (the smoke): the new tail ran ok and labelled the smoke's routes; else roll it back
  [ -n "${TAIL_NEW:-}" ] || return 0
  echo "== tail check ($TAIL_NEW)"
  if python3 -I "$WT/scripts/obs/tail-check.py" --version "$TAIL_NEW" --minutes 5 --wait 150 --require /v1/track,/v1/sightline,/v1/alignment/search,/llms.txt,/docs/interactive; then
    git -C "$ROOT" tag -f "deployed-tail/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null; echo "== deployed ephem-tail $SHA ($TAIL_NEW)"; return 0
  fi
  route ephem-tail "rollback: tail check failed for $TAIL_NEW [git $SHA]" "$TAIL_PREV:100"
  echo "TAIL CHECK FAILED: ephem-tail rolled back to $TAIL_PREV" >&2; return 1
}

# --- live watcher (EPHEM_DEPLOY_LIVE=1): after promotion, detached from the deploy -----------------------------------------
# The deploy is done at promotion (+ the live smoke); this process keeps watching: the deferred full canary check (when the
# canary gate passed early), the live gate (live smoke + O11Y_LIVE_S s of real traffic) and the tail check, in parallel. Any
# failure rolls ephem back to PREV (only if NEW still serves 100%), deletes the deployed/ tag, writes the verdict to
# $LIVEDIR/<sha>.result and the ship log, and sends a macOS notification. It holds $LL; the next deploy waits for it before
# it reads the active version, so a rollback can never clobber a newer canary. It owns the worktree and removes it.
if [ "${EPHEM_DEPLOY_LIVE:-}" = 1 ]; then
  trap 'git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$LL"' EXIT
  trap '' HUP
  echo "$SHA $NEW pid $$ $(iso_now)" > "$LL/owner"
  echo "== live watcher pid $$ for $SHA ($NEW, previous $PREV): live gate ${O11Y_LIVE_S}s$([ "$CANARY_EARLY" = 1 ] && echo " + deferred full canary check")${TAIL_NEW:+ + tail check}"
  TW=$(now); pids=""
  if [ "$CANARY_EARLY" = 1 ]; then o11y_gate ephem "$NEW" "$PREV" "$CS" "$RUN" "$WT/.manifest-canary" --until "$T0ISO" > "$WT/.w-canary" 2>&1 & pids="$pids $!"; fi
  o11y_gate ephem "$NEW" "$PREV" "$T0ISO" "$LRUN" "$WT/.manifest-live" --live "$O11Y_LIVE_S" > "$WT/.w-live" 2>&1 & pids="$pids $!"
  [ -n "${TAIL_NEW:-}" ] && { tail_verify > "$WT/.w-tail" 2>&1 & TPID=$!; }
  BAD=""; for p in $pids; do wait "$p" || BAD="$BAD $p"; done
  [ "$CANARY_EARLY" = 1 ] && { echo "== deferred full canary check"; cat "$WT/.w-canary"; }
  echo "== live gate"; cat "$WT/.w-live"
  TAILR=""; if [ -n "${TAIL_NEW:-}" ]; then if wait "$TPID"; then TAILR=" tail=ok"; else TAILR=" tail=ROLLED-BACK"; fi; cat "$WT/.w-tail"; fi
  W=$(since "$TW")
  if [ -z "$BAD" ]; then
    R="ok"; echo "== live verdict: ok for $SHA ($NEW) after ${W}s"
  else
    why=$( { grep -h '^   FAIL' "$WT/.w-live" "$WT/.w-canary" 2>/dev/null || true; } | head -1 | sed 's/^ *FAIL *//' | cut -c1-140)
    [ -n "$why" ] || why=$( { grep -hE 'failed|Error|exit [1-9]' "$WT/.w-live" "$WT/.w-canary" 2>/dev/null || true; } | head -1 | cut -c1-140)
    cur=$(active ephem || true)
    if [ "$cur" = "$NEW" ]; then
      rollback_ephem "live gate failed"
      git -C "$ROOT" tag -d "$TAG" >/dev/null 2>&1 || true
      R="ROLLED-BACK to ${PREV:0:8}: $why"
    else
      R="FAILED but not rolled back: ephem now serves ${cur:-a split deployment}, not $NEW: $why"
    fi
    echo "LIVE CHECK FAILED on $NEW: $R" >&2
    notify "ephem deploy rolled back" "$SHA ${NEW:0:8}: $why"
  fi
  for m in canary live; do cp "$WT/.manifest-$m" "$LIVEDIR/$SHA-$m.manifest" 2>/dev/null || true; done   # for a postmortem
  printf '%s live %s %s %s%s watched=%ss\n' "$(iso_now)" "$SHA" "${NEW:0:8}" "$R" "$TAILR" "$W" | tee "$LIVEDIR/$SHA.result"
  [ -n "${EPHEM_SHIP_LOG:-}" ] && cat "$LIVEDIR/$SHA.result" >> "$EPHEM_SHIP_LOG"
  [ "$R" = ok ] || exit 1
  exit 0
fi

# --- deploy --------------------------------------------------------------------------------------------------------------
LOCK=${EPHEM_DEPLOY_LOCK:?inner deploy.sh needs EPHEM_DEPLOY_LOCK (run scripts/deploy.sh, not the inner copy)}
KEEP_WT=0   # set once the live watcher owns the worktree
cleanup() { [ "${TIMED:-0}" = 0 ] && echo "== timings$TIMINGS failed_at=$(since "$T_INNER")"; [ -n "${UP_PID:-}" ] && wait "$UP_PID" 2>/dev/null; [ $KEEP_WT = 0 ] && [ -n "$WT" ] && git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$LOCK"; }
trap cleanup EXIT
# One deploy at a time, and never backwards: concurrent agents' deploys raced and an older commit replaced a newer one
# for ~2 min (2026-10-30). A rollback or A/B of an older commit needs ALLOW_OLDER=1.
grep -q "^$SHA pid $$ " "$LOCK/owner" 2>/dev/null || { echo "inner deploy.sh: lock $LOCK is not this deploy's ($(cat "$LOCK/owner" 2>/dev/null))" >&2; exit 1; }
[ "$(git -C "$WT" rev-parse --short=12 HEAD)" = "$SHA" ] || { echo "inner deploy.sh: worktree $WT is not at $SHA" >&2; exit 1; }
echo "== inner: deploy logic from $SHA's scripts/deploy.sh"
LAST_TAIL=$(git -C "$ROOT" tag --list 'deployed-tail/*' --sort=-refname | head -1)
LAST_LOAD=$(git -C "$ROOT" tag --list 'deployed-load/*' --sort=-refname | head -1)
older() { [ -n "$1" ] && [ "${ALLOW_OLDER:-}" != 1 ] && ! git -C "$ROOT" merge-base --is-ancestor "$1" "$SHA"; }
changed() { [ -z "$1" ] || ! git -C "$ROOT" diff --quiet "$1" "$SHA" -- "${@:2}"; }
tc_changed() { [ -n "$LAST" ] && git -C "$ROOT" diff "$LAST" "$SHA" -- packages/worker/cloudflare.config.ts | grep -qE '^[+-][^+-].*tailConsumers'; }
DO_TAIL=0; DO_EPHEM=0; DO_LOAD=0
case "$TARGET" in
  ephem) DO_EPHEM=1 ;; tail) DO_TAIL=1 ;; load) DO_LOAD=1 ;; all) DO_TAIL=1; DO_EPHEM=1; DO_LOAD=1 ;;
  auto) DO_EPHEM=1; { changed "$LAST_TAIL" packages/tail packages/worker/src/routes.ts packages/worker/ops/basin/invocations.schema.json || tc_changed; } && DO_TAIL=1
        changed "$LAST_LOAD" packages/load && DO_LOAD=1 ;;
esac
for t in $([ $DO_EPHEM = 1 ] && echo "$LAST") $([ $DO_TAIL = 1 ] && echo "$LAST_TAIL") $([ $DO_LOAD = 1 ] && echo "$LAST_LOAD"); do
  older "$t" && { echo "$SHA does not contain the last deployed commit ($t = $(git -C "$ROOT" rev-parse --short=12 "$t")): rebase onto main, or ALLOW_OLDER=1 for a rollback" >&2; exit 1; }
done
echo "== targets @ $SHA: $([ $DO_LOAD = 1 ] && echo "ephem-load ")$([ $DO_TAIL = 1 ] && echo "ephem-tail ")$([ $DO_EPHEM = 1 ] && echo ephem)"
MODE=gradual
if [ "${GRADUAL:-1}" = 0 ] || { [ -n "$LAST" ] && git -C "$ROOT" diff "$LAST" "$SHA" -- packages/worker/cloudflare.config.ts | grep -qE '^[+-][^+-].*(tailConsumers|observability|logpush)'; }; then MODE=direct; fi

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
stage setup

# Upload the ephem version while the gate runs: an uploaded version is in no deployment, so nothing can reach it (not even a
# version override) until it is routed 0% below, which happens only after the gate passed.
UP_PID=""
if [ $DO_EPHEM = 1 ] && [ $MODE = gradual ] && [ "${DRY:-}" != 1 ]; then
  ( rc=0; cd "$WT/packages/worker" && cf workers versions create --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" > "$WT/.upload.out" 2>&1 || rc=$?
    echo $rc > "$WT/.upload.rc"; since "$T_STAGE" > "$WT/.upload.t" ) &
  UP_PID=$!
fi
wait_upload() { [ -n "$UP_PID" ] && { wait "$UP_PID" || true; UP_PID=""; }; return 0; }

echo "== gate @ $SHA"
cd "$WT"
# Content-addressed pass cache: the gate's verdict depends on the tree and on node_modules (linked from the main checkout),
# so a tree that already passed with the same node_modules skips it. Key: tree hash + hash of node_modules/.package-lock.json.
GKEY="$(git -C "$WT" rev-parse "HEAD^{tree}")-$(shasum -a 256 "$ROOT/node_modules/.package-lock.json" 2>/dev/null | cut -c1-16)"
GPASS="$GITDIR/ephem-gate-pass/$GKEY"
if [ -f "$GPASS" ] && [ "${NO_GATE_CACHE:-}" != 1 ]; then
  echo "gate: tree $(echo "$GKEY" | cut -c1-12) already passed ($(cat "$GPASS")); skipped (NO_GATE_CACHE=1 re-runs it)"
else
  # typecheck, lint and tests in parallel. Each runs as its own command and is checked on its own: a failure inside an &&
  # list does not trip `set -e` (found 2026-10-30, 3c87955).
  ( npm run typecheck > "$WT/.typecheck.log" 2>&1 ) & P_TC=$!
  ( npm run lint > "$WT/.lint.log" 2>&1 ) & P_LINT=$!
  ( npm test > "$WT/.test.log" 2>&1 ) & P_TEST=$!
  G=""; wait $P_TC || G="$G typecheck"; wait $P_LINT || G="$G lint"; wait $P_TEST || G="$G tests"
  if [ -n "$G" ]; then
    for k in $G; do f=$k; [ "$k" = tests ] && f=test; echo "--- $k"; tail -40 "$WT/.$f.log"; done >&2
    wait_upload; echo "GATE FAILED:$G" >&2; exit 1
  fi
  grep -E 'Test Files|Tests ' "$WT/.test.log"
  mkdir -p "$GITDIR/ephem-gate-pass"; echo "$SHA $(iso_now)" > "$GPASS"
fi
[ -x "$WT/scripts/smoke.sh" ] || [ -f "$WT/scripts/smoke.sh" ] || { echo "$SHA has no scripts/smoke.sh" >&2; exit 1; }
stage gate
[ "${DRY:-}" = 1 ] && { TIMED=1; echo "== DRY=1: gate passed @ $SHA, not deploying"; exit 0; }

# The previous deploy's live watcher may still be judging its version (and may roll it back): wait for its verdict before
# reading the active version or touching any deployment.
if [ -d "$LL" ]; then
  echo "== waiting for the previous deploy's live watcher ($(cat "$LL/owner" 2>/dev/null))"
  TWL=$(now)
  while [ -d "$LL" ]; do
    lp=$(awk '{print $4}' "$LL/owner" 2>/dev/null || true)
    if [ -n "$lp" ] && ! kill -0 "$lp" 2>/dev/null; then echo "   stale live lock (pid $lp gone): removed"; rm -rf "$LL"; break; fi
    [ "$(python3 -c "import sys,time; print(int(time.time()-float(sys.argv[1]) > 300))" "$TWL")" = 1 ] && { wait_upload; echo "the previous live watcher is still running after 300 s ($LL); not deploying" >&2; exit 1; }
    sleep 1
  done
  echo "   previous live watcher done after $(since "$TWL")s: $(ls -t "$LIVEDIR"/*.result 2>/dev/null | head -1 | xargs cat 2>/dev/null)"
fi
stage wait_prev
# --- ephem-load ------------------------------------------------------------------------------------------------------------
# A new Worker with Durable Objects (exports), deployed whole (cf deploy). Checked from outside; rolled back on any failure.
if [ $DO_LOAD = 1 ]; then
  LB=https://ephem-load.ivar.workers.dev; LOAD_PREV=""
  exists ephem-load && { LOAD_PREV=$(active ephem-load); [ -n "$LOAD_PREV" ] || { echo "ephem-load has a split deployment; resolve it first" >&2; exit 1; }; }
  echo "== deploy ephem-load @ $SHA (previous ${LOAD_PREV:-none: first deploy})"
  cd "$WT/packages/load"
  out=$(cf deploy --message "$MSG [git $SHA]" 2>&1) || { echo "$out" | tail -20 >&2; echo "ephem-load deploy failed" >&2; exit 1; }
  LOAD_NEW=$(echo "$out" | sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$LOAD_NEW" ] || { echo "$out" | tail -20 >&2; echo "ephem-load deploy: no version id in the output" >&2; exit 1; }
  echo "ephem-load $LOAD_NEW"
  load_check() {
    local t0 v ok=0 h c LT="${EPHEM_LOAD_TOKEN:-$(cat "$HOME/.config/ephem-load/token" 2>/dev/null)}"
    t0=$(now)
    while :; do   # 5 consecutive /health answers from the new version
      v=$(curl -s --max-time 10 "$LB/health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version") or "")' 2>/dev/null)
      if [ "$v" = "$LOAD_NEW" ]; then ok=$((ok + 1)); [ $ok -ge 5 ] && break; else ok=0; fi
      [ "$(python3 -c "import sys,time; print(int(time.time()-float(sys.argv[1]) > 60))" "$t0")" = 1 ] && { echo "FAIL ephem-load: /health never answered from $LOAD_NEW"; return 1; }
      sleep 0.5
    done
    echo "ok   load-health $LOAD_NEW serving after $(since "$t0")s"
    if [ -n "$LT" ] && [ "$(curl -s --max-time 10 "$LB/health" | python3 -c 'import json,sys; print(json.load(sys.stdin)["configured"])')" != True ]; then
      # first deploy: the secret can only be set on an existing Worker. load-token.sh stores it (a new version); wait for that one.
      echo "== ephem-load has no LOAD_TOKEN: setting it from ~/.config/ephem-load/token (scripts/obs/load-token.sh)"
      bash "$WT/scripts/obs/load-token.sh" || { echo "FAIL load-secret: could not set LOAD_TOKEN"; return 1; }
      LOAD_NEW=$(active ephem-load); [ -n "$LOAD_NEW" ] || { echo "FAIL load-secret: split deployment after the secret"; return 1; }
      t0=$(now); ok=0
      while [ $ok -lt 5 ]; do
        v=$(curl -s --max-time 10 "$LB/health" | python3 -c 'import json,sys; j=json.load(sys.stdin); print((j.get("version") or "") + ("+" if j.get("configured") else ""))' 2>/dev/null)
        if [ "$v" = "$LOAD_NEW+" ]; then ok=$((ok + 1)); else ok=0; fi
        [ "$(python3 -c "import sys,time; print(int(time.time()-float(sys.argv[1]) > 60))" "$t0")" = 1 ] && { echo "FAIL load-secret: $LOAD_NEW never answered configured"; return 1; }
        sleep 0.5
      done
      echo "ok   load-secret LOAD_TOKEN set; $LOAD_NEW serving"
    fi
    h=$(curl -s --max-time 10 "$LB/health")
    echo "$h" | python3 -c 'import json,sys; j=json.load(sys.stdin); assert j["service"]=="ephem-load" and j["target"]=="https://ephem.ivar.workers.dev" and j["limits"]["maxRate"]<=300 and j["limits"]["maxDurationS"]<=600, j' \
      && echo "ok   load-health-body target + limits" || { echo "FAIL load-health-body: $h"; return 1; }
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' -d '{"mode":"position","rate":1,"duration":1,"regions":["enam"]}' "$LB/run")
    [ "$c" = 401 ] || [ "$c" = 503 ] && echo "ok   load-noauth POST /run without the token -> $c" || { echo "FAIL load-noauth: POST /run without the token -> $c"; return 1; }
    if [ -z "$LT" ]; then echo "!! no ~/.config/ephem-load/token: skipped the authorized checks (load-limits, load-run)" >&2; return 0; fi
    [ "$(echo "$h" | python3 -c 'import json,sys; print(json.load(sys.stdin)["configured"])')" = True ] || { echo "FAIL load-secret: LOAD_TOKEN is not set on ephem-load"; return 1; }
    c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H "authorization: Bearer $LT" -H 'content-type: application/json' -d '{"mode":"position","rate":10000,"duration":1,"regions":["enam"]}' "$LB/plan")
    [ "$c" = 400 ] && echo "ok   load-limits over-limit /plan -> 400" || { echo "FAIL load-limits: over-limit /plan -> $c"; return 1; }
    local o; o=$(cd "$WT" && EPHEM_LOAD_TOKEN="$LT" LOAD_DIR="$WT/.load-runs" node --experimental-strip-types scripts/obs/load-remote.ts --base "$LB" --mode position --rate 2 --duration 5 --regions enam --run-id "d-$SHA-$(date +%s)" --quiet 2>&1)
    local rc=$?
    if [ $rc = 0 ]; then echo "ok   load-run $(echo "$o" | grep '^run .*ok' | head -1)"
    elif echo "$o" | grep -q 'HTTP 409'; then echo "!! load-run skipped: another run is live ($(echo "$o" | grep -o 'run [^ ]* is live[^(]*'))" >&2
    else echo "$o" | tail -8; echo "FAIL load-run (exit $rc)"; return 1; fi
  }
  if load_check; then
    git -C "$ROOT" tag -f "deployed-load/$(date -u +%Y%m%dT%H%M%SZ)" "$SHA" >/dev/null; echo "== deployed ephem-load $SHA ($LOAD_NEW)"
  else
    if [ -n "$LOAD_PREV" ]; then route ephem-load "rollback: load check failed for $LOAD_NEW [git $SHA]" "$LOAD_PREV:100"; echo "LOAD CHECK FAILED: ephem-load rolled back to $LOAD_PREV" >&2
    else echo "LOAD CHECK FAILED on the first ephem-load deploy ($LOAD_NEW); nothing to roll back to (it serves no users). Not tagged." >&2; fi
    exit 1
  fi
fi
# --- ephem-tail ------------------------------------------------------------------------------------------------------------
# --- ephem-tail ------------------------------------------------------------------------------------------------------------
TAIL_NEW=""; TAIL_PREV=""
if [ $DO_TAIL = 1 ]; then
  TAIL_PREV=$(active ephem-tail)
  [ -n "$TAIL_PREV" ] || { wait_upload; echo "ephem-tail has a split deployment; resolve it first" >&2; exit 1; }
  echo "== deploy ephem-tail @ $SHA (previous $TAIL_PREV)"
  cd "$WT/packages/tail"
  out=$(cf deploy --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" 2>&1) || { wait_upload; echo "$out" | tail -20 >&2; echo "ephem-tail deploy failed" >&2; exit 1; }
  TAIL_NEW=$(echo "$out" | sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$TAIL_NEW" ] || { wait_upload; echo "$out" | tail -20 >&2; echo "ephem-tail deploy: no version id in the output" >&2; exit 1; }
  echo "ephem-tail $TAIL_NEW"
  stage tail_deploy
fi
if [ $DO_EPHEM = 0 ]; then
  [ $DO_TAIL = 1 ] && { bash "$WT/scripts/smoke.sh" "$B" >/dev/null || true; }   # traffic for the tail check; ephem itself is unchanged
  tail_verify; exit $?
fi

# --- ephem -----------------------------------------------------------------------------------------------------------------
PREV=$(active ephem) || PREV=""
[ -n "$PREV" ] || { wait_upload; echo "ephem has a split deployment (a canary or rollout in progress); resolve it first" >&2; exit 1; }
PREV_TAG=$LAST
cd "$WT/packages/worker"
echo "== deploy ephem @ $SHA ($MODE; previous $PREV)"
CANARY_EARLY=0; CS=""; RUN=""
if [ $MODE = gradual ]; then
  wait_upload; out=$(cat "$WT/.upload.out" 2>/dev/null || true)
  [ "$(cat "$WT/.upload.rc" 2>/dev/null)" = 0 ] || { echo "$out" | tail -20 >&2; echo "version upload failed" >&2; exit 1; }
  NEW=$(echo "$out" | sed -n 's/.*Worker Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$NEW" ] || { echo "$out" | tail -20 >&2; echo "version upload: no version id in the output" >&2; exit 1; }
  echo "$out" | grep -E 'Startup Time|Total Upload' || true
  TIMINGS="$TIMINGS upload=$(cat "$WT/.upload.t" 2>/dev/null)(parallel)"; stage upload_wait
  echo "uploaded $NEW; routing it 0% (canary) beside $PREV 100%"
  route ephem "canary 0%: $MSG [git $SHA]" "$NEW:0" "$PREV:100"
  stage route_canary
  s=$(serving "$NEW" 60 pin) || { route ephem "canary abandoned: pin never reached $NEW [git $SHA]" "$PREV:100"; echo "CANARY FAILED: a pinned request never reached $NEW in ${s}s; removed it (prod stayed on $PREV)" >&2; exit 1; }
  echo "pinned requests reach $NEW after ${s}s"
  stage pin_wait
  CS=$(iso_now); RUN="c-$SHA-$(date +%s)"; : > "$WT/.manifest-canary"
  if ! smoke_twice canary --pin "$NEW" --expect-compute "$NEW" $(gate_args "$RUN" "$WT/.manifest-canary"); then
    route ephem "canary failed: $MSG [git $SHA]" "$PREV:100"
    echo "CANARY SMOKE FAILED on $NEW (twice): prod never served it; removed it from the deployment (100% $PREV)" >&2; exit 1
  fi
  stage smoke_canary
  # Early pass (canary-gate.py --early): 0 errors + every required span/entrypoint + 75% of the smoke's requests visible.
  # The rest of the ingest is judged by the live watcher (deferred full check, --until promotion), which rolls back.
  if ! o11y_gate ephem "$NEW" "$PREV" "$CS" "$RUN" "$WT/.manifest-canary" --early "${O11Y_EARLY:-0.75}" --poll 2 --json "$LIVEDIR/$SHA-canary.json" | tee "$WT/.gate-canary.out"; then
    TR=$(now); route ephem "canary failed: telemetry gate: $MSG [git $SHA]" "$PREV:100"
    echo "CANARY TELEMETRY GATE FAILED on $NEW: removed it from the deployment in $(since "$TR")s (100% $PREV; prod never served it). Not tagged." >&2; exit 1
  fi
  grep -q '^GATE ok (early' "$WT/.gate-canary.out" && CANARY_EARLY=1
  stage o11y_canary
  T0ISO=$(iso_now); T0=$(now); route ephem "$MSG [git $SHA]" "$NEW:100"; echo "promoted $NEW to 100% ($(since "$T0")s)"
else
  wait_upload
  T0ISO=$(iso_now); T0=$(now)
  out=$(cf deploy --message "$(printf '%s' "$MSG [git $SHA]" | cut -c1-100)" 2>&1) || { echo "$out" | tail -20 >&2; echo "deploy failed" >&2; exit 1; }
  NEW=$(echo "$out" | sed -n 's/.*Current Version ID: *\([0-9a-f-]*\).*/\1/p' | head -1)
  [ -n "$NEW" ] || { echo "$out" | tail -20 >&2; echo "deploy: no version id in the output" >&2; exit 1; }
  echo "$out" | grep -E 'Startup Time' || true
fi
stage promote; T_PROMOTED=$(now)
# Wait for the new version to serve, not a fixed sleep: /healthz from $NEW five times in a row (the old 5 s sleep did not
# guarantee it). A version that never serves counts as a failed smoke.
LIVE_OK=1
if s=$(serving "$NEW" 60); then echo "$NEW serving all of 5 consecutive /healthz ${s}s after promotion"; else echo "FAIL $NEW not serving after ${s}s"; LIVE_OK=0; fi
stage serving
LRUN="l-$SHA-$(date +%s)"; : > "$WT/.manifest-live"
[ $LIVE_OK = 1 ] && { smoke_twice live --expect "$NEW" --expect-compute "$NEW" $(gate_args "$LRUN" "$WT/.manifest-live") || LIVE_OK=0; }
stage smoke_live
if [ $LIVE_OK = 0 ]; then
  rollback_ephem "live smoke failed"
  echo "LIVE CHECK FAILED on $NEW (smoke twice): rolled back to $PREV. Not tagged." >&2; exit 1
fi
TAG="deployed/$(date -u +%Y%m%dT%H%M%SZ)"
git -C "$ROOT" tag -f "$TAG" "$SHA" >/dev/null
TO100=$(python3 -c "print(f'{float(\"$T_PROMOTED\")-float(\"$T_INNER\"):.1f}')")
echo "== deployed ephem $SHA ($NEW): 100% at +${TO100}s, live smoke ok; tagged $TAG"
# The live watcher: detached (own session: survives this terminal and the caller), holds $LL, owns the worktree from here.
# It gets $SHA, not $REV: `deploy.sh main` re-resolved in the watcher named the newer main (found 2026-10-31, 91e5e6e).
LIVELOG="$LIVEDIR/$SHA-$(date -u +%Y%m%dT%H%M%SZ).log"
mkdir -p "$LL"; echo "$SHA $NEW pid - $(iso_now)" > "$LL/owner" || true   # never fail here: NEW serves 100%
export EPHEM_DEPLOY_LIVE=1 NEW PREV PREV_TAG CS RUN T0ISO LRUN TAG CANARY_EARLY TAIL_NEW TAIL_PREV O11Y_LIVE_S
if [ "${LIVE_WAIT:-}" = 1 ]; then   # foreground: the deploy's exit code includes the live verdict (old behaviour)
  KEEP_WT=1; rm -rf "$LOCK"; trap - EXIT; TIMED=1
  echo "TIMINGS$TIMINGS to_100=$TO100 promoted_at=$T_PROMOTED new=$NEW live_log=$LIVELOG" | sed 's/^TIMINGS/== timings/'
  bash "$WT/scripts/deploy.sh" "$SHA" "$MSG" "$TARGET" 2>&1 | tee "$LIVELOG"; exit "${PIPESTATUS[0]}"
fi
perl -MPOSIX -e 'POSIX::setsid(); open STDIN, "<", "/dev/null"; exec @ARGV or die' bash "$WT/scripts/deploy.sh" "$SHA" "$MSG" "$TARGET" > "$LIVELOG" 2>&1 &
WPID=$!
KEEP_WT=1
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q " pid $WPID " "$LL/owner" 2>/dev/null && break; sleep 0.2; done
echo "== live gate + deferred checks in the background: watcher pid $WPID, log $LIVELOG (verdict: $LIVEDIR/$SHA.result; rollback is automatic)"
stage spawn_watcher
echo "== timings$TIMINGS to_100=$TO100 total=$(since "$T_INNER") promoted_at=$T_PROMOTED new=$NEW live_log=$LIVELOG"; TIMED=1
}
main "$@"
