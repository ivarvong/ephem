#!/bin/bash
# The repo's formatters, one entry point (npm run format / npm run format:check; the deploy gate runs the check):
#   prettier   TS, TSX, JS, CSS, JSON, YAML (.prettierrc.json; the skips, Markdown among them, and why: .prettierignore)
#   ruff       Python: `ruff format` + import order (`ruff check`, rule I) (ruff.toml: line length 120)
#   shfmt      shell: `shfmt -i 2 -ci`
# ruff and shfmt run through uvx at pinned versions (no Python deps in the repo; uv caches them after the first run).
#   scripts/format.sh            # write
#   scripts/format.sh --check    # verify only (exit 1 and list the files on any difference)
set -uo pipefail
cd "$(dirname "$0")/.."
RUFF=ruff==0.17.3
SHFMT=shfmt-py==4.2.0 # shfmt v3.14.1
UVX=$(command -v uvx || echo "$HOME/.local/bin/uvx")
[ -x "$UVX" ] || {
  echo "format.sh: uvx not found (install uv: https://docs.astral.sh/uv/)" >&2
  exit 2
}
# tracked + untracked-not-ignored files of a type (not .claude/: agent worktrees)
files() { git ls-files -co --exclude-standard -- "$1" ':!.claude' | while read -r f; do [ -f "$f" ] && echo "$f"; done; }
py() { files '*.py'; }
shells() { files '*.sh'; }

if [ "${1:-}" = --check ]; then
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  (npx prettier --check --log-level=warn . >"$T/prettier" 2>&1) &
  P1=$!
  (py | xargs "$UVX" -q "$RUFF" format --check >"$T/ruff" 2>&1 && py | xargs "$UVX" -q "$RUFF" check -q >>"$T/ruff" 2>&1) &
  P2=$!
  (shells | xargs "$UVX" -q --from "$SHFMT" shfmt -i 2 -ci -l >"$T/shfmt" 2>&1 && [ ! -s "$T/shfmt" ]) &
  P3=$!
  F=""
  wait $P1 || F="$F prettier"
  wait $P2 || F="$F ruff"
  wait $P3 || F="$F shfmt"
  if [ -n "$F" ]; then
    for k in $F; do
      echo "--- $k"
      cat "$T/$k"
    done >&2
    echo "FORMAT CHECK FAILED:$F (run: npm run format)" >&2
    exit 1
  fi
  echo "format: ok (prettier, ruff, shfmt)"
else
  # prettier twice: a member chain can settle only on the second pass (prettier is not always idempotent)
  npx prettier --write --log-level=warn . && npx prettier --write --log-level=warn . || exit 1
  # format first (it splits `import x; stmt` lines the import sorter cannot fix), sort imports, format again
  py | xargs "$UVX" -q "$RUFF" format -q && py | xargs "$UVX" -q "$RUFF" check -q --fix &&
    py | xargs "$UVX" -q "$RUFF" format -q || exit 1
  shells | xargs "$UVX" -q --from "$SHFMT" shfmt -i 2 -ci -w || exit 1
fi
