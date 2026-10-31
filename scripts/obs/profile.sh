#!/bin/bash
# CPU (or heap) profile of an exact prod version under uncached load, saved as pprof and summarized.
#   scripts/obs/profile.sh <version-uuid> [cpu|heap] [ms=10000]
# The profiler needs an isolate executing *when the request lands* ("10393 No recent executions" otherwise), so load
# starts first and keeps running through the capture; the call is retried a few times.
set -u
V=${1:?usage: profile.sh <full-version-uuid> [cpu|heap] [ms]}
TYPE=${2:-cpu}
MS=${3:-10000}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=$ROOT/profiles/${V:0:8}-$TYPE-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ROOT/profiles"
(for _ in 1 2 3; do "$HERE/load.sh" 40; done >"$OUT.load.txt") &
LOAD=$!
sleep 5
ok=0
for attempt in 1 2 3 4; do
  if (cd "$ROOT/packages/worker" && cf workers versions profile "$V" --worker-id ephem --profile-type "$TYPE" --duration-ms "$MS" >"$OUT.pb" 2>"$OUT.err"); then
    ok=1
    break
  fi
  echo "attempt $attempt failed: $(grep -ho '\[[0-9]*\][^│]*' "$OUT.err" "$OUT.pb" | head -1)" >&2
  sleep 3
done
wait $LOAD
echo "load: $(awk '{print $1,$2}' "$OUT.load.txt" | sort | uniq -c | tr '\n' ' ')"
[ $ok = 1 ] || {
  echo "profile failed; see $OUT.err" >&2
  exit 1
}
rm -f "$OUT.err"
python3 "$HERE/symbolize.py" "$OUT.pb" "$OUT.sym.pb"
echo "profile: $OUT.pb (raw)  $OUT.sym.pb (function names from source)"
go tool pprof -top -lines -nodecount=25 "$OUT.sym.pb" 2>/dev/null | sed -n '2,40p'
