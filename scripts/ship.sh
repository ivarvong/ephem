#!/bin/bash
# ship.sh: deploy every commit on main to prod, automatically (ivar, 2026-10-31: "Ship every commit fast").
#   scripts/ship.sh start | stop | restart | status | log [n] | retry | run | once <rev>
# start    launch the watcher detached (its own session, nohup'd: survives this terminal; pid in .git/ephem-ship/pid)
# stop     stop the watcher (a deploy in progress finishes first; a live watcher always finishes its verdict/rollback)
# status   watcher, main vs deployed, pending commits, deploy lock, live watcher, last log lines
# retry    forget the last failed head so the watcher tries it again (a flake, or an infra failure)
# run      the loop in the foreground (what start runs)
# once     one deploy of <rev> with ship's logging and notification (used for the failure-path proof on a branch)
#
# The loop polls refs/heads/main every SHIP_POLL_S (2) s. When main is ahead of the last deployed/ tag and is not the head
# that already failed, it runs `scripts/deploy.sh <main> "<message>" auto` (the shared tree's bootstrap execs the commit's own
# deploy logic; the lock serialises it with manual deploys). Coalescing: it always deploys the newest main, which contains
# every commit landed meanwhile; the message lists them. A failed head stays unshipped and is not retried (a red main
# blocks); the next commit on main is tried, and ships only if the gates pass (it contains a fix). One line per deploy in
# $EPHEM_SHIP_LOG (~/code/lab_notebook/ephem-ship.log); the live watcher appends its verdict line ("live …") ~105 s later.
# Failures send a macOS notification. Per-deploy logs: .git/ephem-ship/logs/.
{
set -uo pipefail
ROOT=${EPHEM_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
GITDIR=$(cd "$ROOT" && cd "$(git rev-parse --git-common-dir)" && pwd)   # the shared .git (also from a worktree)
ST="$GITDIR/ephem-ship"; mkdir -p "$ST/logs"
SHIP_LOG=${EPHEM_SHIP_LOG:-$HOME/code/lab_notebook/ephem-ship.log}
POLL=${SHIP_POLL_S:-2}
# The gate's geodesic test needs pyproj; a stable venv (not a session scratchpad) so the watcher outlives any session.
VENV=${EPHEM_GATE_VENV:-$HOME/.cache/ephem-gate-venv}
alive() { [ -f "$ST/pid" ] && kill -0 "$(cat "$ST/pid")" 2>/dev/null; }
short() { git -C "$ROOT" rev-parse --short=12 "$1" 2>/dev/null; }
deployed() { local t; t=$(git -C "$ROOT" tag --list 'deployed/*' --sort=-refname | head -1); [ -n "$t" ] && short "$t^{commit}"; }
notify() { osascript -e "display notification \"$(echo "$2" | tr -d '"\\' | cut -c1-200)\" with title \"$(echo "$1" | tr -d '"\\')\"" >/dev/null 2>&1 || true; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# deploy_one <rev> [<base>]: one deploy through deploy.sh; logs one line; returns deploy.sh's exit code (75 = lock busy)
deploy_one() {
  local head=$1 base=${2:-} n commits msg log rc t0 tl line ver tim result first ct0 ctn
  head=$(short "$head")
  [ -n "$base" ] && commits=$(git -C "$ROOT" log --reverse --format=%h "$base..$head") || commits=$(git -C "$ROOT" log -1 --format=%h "$head")
  n=$(echo "$commits" | grep -c .)
  msg="ship $n: $(echo "$commits" | head -6 | paste -sd' ' -)$([ "$n" -gt 6 ] && echo " +$((n - 6))"): $(git -C "$ROOT" log -1 --format=%s "$head")"
  log="$ST/logs/$(date -u +%Y%m%dT%H%M%SZ)-$head.log"
  echo "$(iso) deploying $head ($n commit(s) since ${base:-?}); log $log"
  t0=$(date +%s)
  PATH="$VENV/bin:$PATH" EPHEM_SHIP_LOG="$SHIP_LOG" bash "$ROOT/scripts/deploy.sh" "$head" "$(printf '%s' "$msg" | cut -c1-90)" auto > "$log" 2>&1 < /dev/null
  rc=$?
  if [ $rc != 0 ] && grep -q 'another deploy is running' "$log" && [ "$(wc -l < "$log")" -le 2 ]; then return 75; fi
  tl=$(grep '^== timings' "$log" | tail -1)
  ver=$(echo "$tl" | grep -o 'new=[0-9a-f-]*' | cut -c5-12)
  [ -n "$ver" ] || ver=$(grep -oE 'uploaded [0-9a-f-]{36}' "$log" | head -1 | cut -c10-17)
  # commit -> 100%: the promotion instant minus each shipped commit's commit time (oldest and newest)
  first=$(echo "$commits" | head -1)
  ct0=$(git -C "$ROOT" log -1 --format=%ct "$first"); ctn=$(git -C "$ROOT" log -1 --format=%ct "$head")
  tim=$(echo "$tl" | sed 's/^== timings //; s/ new=[^ ]*//; s/ live_log=[^ ]*//; s/ promoted_at=[^ ]*//')
  if [ $rc = 0 ]; then
    local pa; pa=$(echo "$tl" | grep -o 'promoted_at=[0-9.]*' | cut -d= -f2)
    result="promoted (live gate pending: $GITDIR/ephem-live/$head.result) commit->100%=$(python3 -c "print(f'{$pa-$ctn:.0f}s newest, {$pa-$ct0:.0f}s oldest')")"
  else
    result="FAILED: $(grep -hE 'GATE FAILED|SMOKE FAILED|CANARY|LIVE CHECK FAILED|ROLLBACK:|does not contain|failed' "$log" | grep -v '^== ' | tail -2 | paste -sd'|' - | cut -c1-200)"
    notify "ephem ship FAILED" "$head: $result"
  fi
  line="$(iso) ship $head [$(echo "$commits" | paste -sd, -)] ver=${ver:-none} wall=$(( $(date +%s) - t0 ))s rc=$rc $result | $tim | log=$log"
  echo "$line" | tee -a "$SHIP_LOG"
  return $rc
}

loop() {
  echo $$ > "$ST/pid"; trap 'rm -f "$ST/pid"; exit 0' TERM INT; trap '' HUP
  echo "$(iso) ship.sh watcher pid $$ on $ROOT (main), poll ${POLL}s, log $SHIP_LOG"
  while :; do
    [ -f "$ST/stop" ] && { rm -f "$ST/stop" "$ST/pid"; echo "$(iso) stopped"; exit 0; }
    head=$(short refs/heads/main); dep=$(deployed); failed=$(cat "$ST/failed" 2>/dev/null || true)
    # rolled back by its live watcher after promotion (its deployed/ tag is gone): failed too, not to be redeployed
    [ -n "$head" ] && grep -qE 'ROLLED-BACK|FAILED' "$GITDIR/ephem-live/$head.result" 2>/dev/null && failed=$head
    # ...except once, automatically, when nothing reported an error: telemetry that never arrived (a single-request check's
    # invocation lost at ingest, 3 of ~790 smoke requests on 2026-10-31) or an o11y API failure. Every gate runs again.
    if [ -n "$head" ] && [ "$failed" = "$head" ] && [ "$(cat "$ST/retried" 2>/dev/null)" != "$head" ] \
       && { cat "$GITDIR/ephem-live/$head.result" "$(ls -t "$ST"/logs/*-"$head".log 2>/dev/null | head -1)" 2>/dev/null || true; } \
          | grep -qE 'GATE FAILED: 0 errors, [0-9]+ missing|no invocation or root span|query failed' \
       && ! { cat "$(ls -t "$GITDIR"/ephem-live/"$head"-*.log 2>/dev/null | head -1)" "$(ls -t "$ST"/logs/*-"$head".log 2>/dev/null | head -1)" 2>/dev/null || true; } \
          | grep -qE 'GATE FAILED: [1-9][0-9]* errors|SMOKE FAILED|^   FAIL  (error log|5xx|outcome|status|version|live):'; then
      echo "$head" > "$ST/retried"; rm -f "$ST/failed" "$GITDIR/ephem-live/$head.result"; failed=""
      echo "$(iso) $head failed on missing telemetry / o11y API only (no error): retrying it once" | tee -a "$SHIP_LOG"
    fi
    if [ -n "$head" ] && [ "$head" != "$dep" ] && [ "$head" != "$failed" ] && ! { [ -n "$dep" ] && git -C "$ROOT" merge-base --is-ancestor "$head" "$dep"; } \
       && [ ! -d "$GITDIR/ephem-deploy.lock" ]; then
      deploy_one "$head" "$dep"; rc=$?
      case $rc in
        0) rm -f "$ST/failed" ;;
        75) echo "$(iso) lock busy (a manual deploy); will retry" ;;
        *) echo "$head" > "$ST/failed"; echo "$(iso) $head failed (rc $rc): main is red until a newer commit passes" ;;
      esac
    fi
    sleep "$POLL"
  done
}

case "${1:-status}" in
  run) loop ;;
  start)
    alive && { echo "ship.sh already running (pid $(cat "$ST/pid"))"; exit 0; }
    [ -x "$VENV/bin/python3" ] && "$VENV/bin/python3" -c 'import pyproj' 2>/dev/null || { echo "creating $VENV (pyproj, for the gate's geodesic test)"; python3 -m venv "$VENV" && "$VENV/bin/pip" install -q pyproj || exit 1; }
    rm -f "$ST/stop"
    # own session (setsid) + nohup: no controlling terminal, so closing this terminal (SIGHUP) or the caller's process group
    # going away does not stop it; launchd would also restart it after a crash or a reboot, but would run with launchd's bare
    # environment (no cf OAuth PATH, node, the venv) and keep deploying after a reboot nobody asked for.
    nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' bash "$ROOT/scripts/ship.sh" run >> "$ST/ship.out" 2>&1 < /dev/null &
    for _ in 1 2 3 4 5 6 7 8 9 10; do alive && break; sleep 0.3; done
    alive && echo "ship.sh started: pid $(cat "$ST/pid"), output $ST/ship.out, deploys logged to $SHIP_LOG" || { echo "ship.sh failed to start; see $ST/ship.out"; exit 1; } ;;
  stop)   # SIGTERM: bash runs the trap after the running deploy (if any) returns, so a deploy is never cut in half
    alive || { echo "ship.sh not running"; rm -f "$ST/pid"; exit 0; }
    p=$(cat "$ST/pid"); kill "$p"
    [ -d "$GITDIR/ephem-deploy.lock" ] && echo "ship.sh (pid $p) stops after the running deploy ($(cat "$GITDIR/ephem-deploy.lock/owner" 2>/dev/null))" || echo "ship.sh stopped (pid $p)" ;;
  restart) bash "$0" stop; while alive; do sleep 1; done; bash "$0" start ;;
  retry) rm -f "$ST/failed" "$GITDIR/ephem-live/$(short refs/heads/main).result"; echo "cleared; the watcher retries main ($(short refs/heads/main))" ;;
  once) deploy_one "${2:?usage: ship.sh once <rev>}" "$(deployed)"; exit $? ;;
  log) tail -"${2:-10}" "$SHIP_LOG" ;;
  status)
    head=$(short refs/heads/main); dep=$(deployed)
    if alive; then echo "watcher: running (pid $(cat "$ST/pid"))"; else echo "watcher: NOT running (scripts/ship.sh start)"; fi
    echo "main $head ($(git -C "$ROOT" log -1 --format='%cr: %s' "$head" | cut -c1-80))"
    echo "deployed $dep$([ "$head" = "$dep" ] && echo " (= main)" || echo "; pending: $(git -C "$ROOT" rev-list --count "$dep..$head" 2>/dev/null) commit(s)")"
    grep -qE 'ROLLED-BACK|FAILED' "$GITDIR/ephem-live/$head.result" 2>/dev/null && echo "ROLLED BACK by its live watcher: $(cat "$GITDIR/ephem-live/$head.result")"
    [ -f "$ST/failed" ] && echo "FAILED head (not retried until main moves or scripts/ship.sh retry): $(cat "$ST/failed")"
    [ -d "$GITDIR/ephem-deploy.lock" ] && echo "deploy running: $(cat "$GITDIR/ephem-deploy.lock/owner" 2>/dev/null)"
    [ -d "$GITDIR/ephem-live.lock" ] && echo "live watcher: $(cat "$GITDIR/ephem-live.lock/owner" 2>/dev/null)"
    echo "prod: $(curl -s -o /dev/null -D - --max-time 5 https://ephem.ivar.workers.dev/healthz | tr -d '\r' | awk -F': ' 'tolower($1)=="x-ephem-version"{print "x-ephem-version " $2}')"
    echo "--- $SHIP_LOG"; tail -4 "$SHIP_LOG" 2>/dev/null ;;
  *) sed -n '2,9p' "$0"; exit 2 ;;
esac
exit 0
}
