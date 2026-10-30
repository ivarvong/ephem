#!/bin/bash
# Smoke ephem: every route, the content checks, and the MCP probe.
#   scripts/smoke.sh <base> [--pin <version-id>] [--expect <version-id>] [--only name,name] [--failed-to <file>]
# --pin     send Cloudflare-Workers-Version-Overrides: ephem="<id>" (a version at 0% in the current deployment) and require
#           x-ephem-version == <id> on every response
# --expect  require x-ephem-version == <id> without pinning (after promotion: catches a response from the old version)
# --only    run only the named checks (deploy.sh retries the failed ones); --failed-to writes the failed names, one per line
# Every body is written to a file and grepped there: `curl | grep -q` under pipefail failed a healthy /docs ~30% of the time
# (grep exits at the match, curl gets EPIPE, exit 23; found 2026-10-30, docs/telemetry_and_profiling.md "Gotchas").
# Exit 0 if all checks passed. Runs from the commit being deployed (deploy.sh calls the worktree's copy).
{
set -uo pipefail
B=${1:?usage: smoke.sh <base> [--pin id] [--expect id] [--only a,b] [--failed-to file]}; B=${B%/}; shift
PIN=""; EXPECT=""; ONLY=""; FAILED_TO=""
while [ $# -gt 0 ]; do case "$1" in
  --pin) PIN=$2; EXPECT=$2; shift 2 ;; --expect) EXPECT=$2; shift 2 ;; --only) ONLY=",$2,"; shift 2 ;; --failed-to) FAILED_TO=$2; shift 2 ;;
  *) echo "smoke.sh: unknown arg $1" >&2; exit 2 ;; esac; done
D=$(mktemp -d "${TMPDIR:-/tmp}/ephem-smoke-XXXX"); trap 'rm -rf "$D"' EXIT
H=(); [ -n "$PIN" ] && H=(-H "cloudflare-workers-version-overrides: ephem=\"$PIN\"")
T=$(date -u +%Y-%m-%dT%H:%M:%SZ); FAILED=(); N=0
want() { [ -z "$ONLY" ] || [[ "$ONLY" == *",$1,"* ]]; }
# chk <name> <want-status> <path> [grep-pattern] [POST-json]
chk() {
  local name=$1 ws=$2 p=$3 pat=${4:-} data=${5:-} c v why=""
  want "$name" || return 0; N=$((N + 1))
  if [ -n "$data" ]; then c=$(curl -s -o "$D/b" -D "$D/h" -w '%{http_code}' --max-time 30 ${H[@]+"${H[@]}"} -X POST -H 'content-type: application/json' -d "$data" "$B$p")
  else c=$(curl -s -o "$D/b" -D "$D/h" -w '%{http_code}' --max-time 30 ${H[@]+"${H[@]}"} "$B$p"); fi
  v=$(tr -d '\r' < "$D/h" | awk -F': ' 'tolower($1)=="x-ephem-version"{print $2}' | tail -1)
  [ "$c" = "$ws" ] || why="status $c, want $ws"
  [ -z "$why" ] && [ -n "$pat" ] && ! grep -q -- "$pat" "$D/b" && why="body lacks $pat"
  [ -z "$why" ] && [ -n "$EXPECT" ] && [ "$v" != "$EXPECT" ] && why="answered by version ${v:-none}, want ${EXPECT:0:8}"
  if [ -z "$why" ]; then echo "ok   $name $c ${v:0:8} $p"; else echo "FAIL $name: $why ($(tr -d '\r' < "$D/h" | awk -F': ' 'tolower($1)=="cf-ray"{print $2}')) $p"; FAILED+=("$name"); fi
}
chk home 200 "/"
chk docs 200 "/docs" 'href="/openapi.json"'                       # useful without JS: links the spec (round-2 #7)
chk docs-interactive 200 "/docs/interactive"
chk llms 200 "/llms.txt" "$B/mcp"                                 # names the MCP endpoint
chk openapi 200 "/openapi.json"
chk healthz 200 "/healthz"
chk position-now 200 "/v1/position?lat=40.7&lon=-74"
chk position-time 200 "/v1/position?lat=40.7&lon=-74&time=$T"
chk day 200 "/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York"
chk magnetic 200 "/v1/magnetic?lat=40.7&lon=-74"
chk crossing 200 "/v1/crossing?lat=40.7&lon=-74&body=sun&altitude=-0.8333&direction=set&date=2026-10-29&tz=America/New_York"
chk alignment 200 "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-29T02:00:00Z&end=2026-10-29T03:00:00Z"
chk sightline 200 "/v1/sightline?observerLat=40.6935&observerLon=-74.0017&observerHeight=5&heightRef=msl&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&samples=11"
chk track 200 "/v1/track?lat=40.7&lon=-74&start=2026-10-29T00:00:00Z&end=2026-10-30T00:00:00Z"
chk weather 200 "/v1/weather?lat=40.7&lon=-74"
chk unknown-param 400 "/v1/day?lat=40.7&lon=-74&date=2026-10-29&tz=America/New_York&bogus=1"
# the customer's Nov 16 2026 pass over a bbox of Brooklyn Bridge Park (fans out to cached window GETs)
chk search 200 "/v1/alignment/search" '"enter":{"time":"2026-11-17T03:4' \
  '{"body":"moon","target":{"lat":40.68925,"lon":-74.0445,"height":70,"heightRef":"msl"},"region":[-73.9995,40.7,-73.993,40.706],"observerHeight":5,"heightRef":"msl","start":"2026-11-16T00:00:00Z","end":"2026-11-18T00:00:00Z"}'
if want mcp; then
  N=$((N + 1))
  if EPHEM_VERSION=$PIN node --experimental-strip-types "$(dirname "$0")/obs/mcp-probe.ts" "$B" > "$D/mcp" 2>&1; then echo "ok   mcp $(tail -1 "$D/mcp")"
  else grep -E 'FAIL' "$D/mcp" | head -5; echo "FAIL mcp: $(tail -1 "$D/mcp")"; FAILED+=("mcp"); fi
fi
[ -n "$FAILED_TO" ] && { : > "$FAILED_TO"; for f in ${FAILED[@]+"${FAILED[@]}"}; do echo "$f" >> "$FAILED_TO"; done; }
if [ ${#FAILED[@]} -eq 0 ]; then echo "SMOKE ok $N/$N${PIN:+ (pinned ${PIN:0:8})}${EXPECT:+ (all from ${EXPECT:0:8})}"; exit 0; fi
echo "SMOKE FAILED ${#FAILED[@]}/$N: ${FAILED[*]}"; exit 1
}
