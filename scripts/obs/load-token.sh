#!/bin/bash
# ephem-load's control token: create it once (~/.config/ephem-load/token, 0600) and store it as the Worker secret LOAD_TOKEN
# (cf workers secrets bulk, from a 0600 temp file that is removed on exit). Never prints the token. deploy.sh runs this on the
# first `load` deploy; rerun it to rotate (delete the file first).    bash scripts/obs/load-token.sh
set -euo pipefail
F=$HOME/.config/ephem-load/token
mkdir -p "$(dirname "$F")"; chmod 700 "$(dirname "$F")"
[ -s "$F" ] || { (umask 077; openssl rand -hex 32 > "$F"); echo "created $F (0600)"; }
chmod 600 "$F"
T=$(mktemp "${TMPDIR:-/tmp}/ephem-load-secret-XXXX"); chmod 600 "$T"; trap 'rm -f "$T"' EXIT
python3 -c 'import json,sys; print(json.dumps({"LOAD_TOKEN": {"type": "secret_text", "text": open(sys.argv[1]).read().strip()}}))' "$F" > "$T"
cf workers secrets bulk --worker ephem-load --secrets "@$T" >/dev/null
echo "LOAD_TOKEN set on ephem-load"
