#!/bin/bash
# Uncached prod load: N rounds of one 24 h Moon alignment + one /v1/day, each with a fresh window/place so the response
# cache misses. Prints "<a|d> <status> <seconds>" per request.   scripts/obs/load.sh [rounds=40] [base=https://ephem.ivar.workers.dev]
# LOAD=weather: instead, per round 4 /v1/weather requests at random lat/lons (land-weighted boxes), ~16 req/s; prints "w <status> <s>".
# LOAD=track: instead, per round 2 homepage-shaped /v1/track requests (72 h, 20-min grid, 217 samples) at fresh lat/lons, ~8 req/s; prints "t <status> <s>".
# LOAD=search: instead, per round one cold 12-month Brooklyn Bridge Park POST /v1/alignment/search (fresh target height:
#   14 never-seen windows), ~2 scans/s (SEARCH_SLEEP=0.5); prints "s <status> <s>".
N=${1:-40}; B=${2:-https://ephem.ivar.workers.dev}
if [ "${LOAD:-}" = weather ]; then
  BOXES=("25 49 -124 -67" "36 60 -10 30" "-38 -12 114 153" "20 45 100 145" "-35 5 -75 -35" "40 70 -170 -60" "-60 80 -180 180")
  for i in $(seq 1 "$N"); do
    for _ in 1 2 3 4; do
      read -r la0 la1 lo0 lo1 <<< "${BOXES[$((RANDOM % ${#BOXES[@]}))]}"
      LAT=$(awk -v a="$la0" -v b="$la1" -v r=$RANDOM 'BEGIN{printf "%.3f", a+(b-a)*r/32767}'); LON=$(awk -v a="$lo0" -v b="$lo1" -v r=$RANDOM 'BEGIN{printf "%.3f", a+(b-a)*r/32767}')
      curl -s -o /dev/null -w "w %{http_code} %{time_total}\n" "$B/v1/weather?lat=$LAT&lon=$LON&n=$((1 + RANDOM % 3))" &
    done
    sleep 0.25
  done
  wait; exit 0
fi
if [ "${LOAD:-}" = search ]; then
  PARK=$(cat "$(dirname "$0")/split-ab/brooklyn-bridge-park.geojson")
  for i in $(seq 1 "$N"); do
    H=$(awk -v r=$RANDOM -v s=$RANDOM -v t="$(date +%s)" 'BEGIN{printf "%.6f", 71 + ((t % 1000) * 1e6 + r * 32768 + s) % 1e9 / 1e9}')
    curl -s -o /dev/null -w "s %{http_code} %{time_total}\n" -X POST -H 'content-type: application/json' "$B/v1/alignment/search" \
      --data "{\"body\":\"moon\",\"target\":{\"lat\":40.68925,\"lon\":-74.0445,\"height\":$H,\"heightRef\":\"msl\"},\"region\":$PARK,\"observerHeight\":5,\"heightRef\":\"msl\",\"start\":\"2026-10-30T00:00:00Z\",\"end\":\"2027-10-30T00:00:00Z\"}" &
    sleep "${SEARCH_SLEEP:-0.5}"
  done
  wait; exit 0
fi
if [ "${LOAD:-}" = track ]; then
  D0=$(( $(date +%s) / 86400 ))
  for i in $(seq 1 "$N"); do
    for _ in 1 2; do
      LAT=$(awk -v r=$RANDOM 'BEGIN{printf "%.4f", -60+120*r/32767}'); LON=$(awk -v r=$RANDOM -v s=$RANDOM 'BEGIN{printf "%.4f", -180+360*(r*32768+s)/1073741823}')
      D=$(( D0 - 1 + RANDOM % 3 )); S=$(date -u -r $(( D * 86400 )) +%Y-%m-%dT%H:%M:%SZ); E=$(date -u -r $(( D * 86400 + 259200 )) +%Y-%m-%dT%H:%M:%SZ)
      curl -s -o /dev/null -w "t %{http_code} %{time_total}\n" "$B/v1/track?lat=$LAT&lon=$LON&start=$S&end=$E" &
    done
    sleep 0.25
  done
  wait; exit 0
fi
iso() { python3 -c "import datetime,sys;print((datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=int(sys.argv[1]))).strftime('%Y-%m-%dT%H:%M:00Z'))" "$1"; }
day() { python3 -c "import datetime,sys;print((datetime.date.today()+datetime.timedelta(days=int(sys.argv[1]))).isoformat())" "$1"; }
for i in $(seq 1 "$N"); do
  off=$((RANDOM * 3 + i * 7)); S=$(iso $off); E=$(iso $((off + 1440)))
  curl -s -o /dev/null -w "a %{http_code} %{time_total}\n" "$B/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=$S&end=$E" &
  curl -s -o /dev/null -w "d %{http_code} %{time_total}\n" "$B/v1/day?lat=40.7&lon=-74.0$((RANDOM % 100))&date=$(day $((RANDOM % 3000)))&tz=America/New_York" &
  sleep 0.2
done
wait
