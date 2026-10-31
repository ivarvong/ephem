#!/usr/bin/env bash
# WRANGLER_DOCKER_BIN for every ephem build (scripts/deploy.sh exports it). wrangler 4.154's build step always runs
# `docker image ls --filter reference=cloudflare-build/<hash>/*` (cleanupPreviousBuildOutputImageTags) through a synchronous
# execFileSync with no timeout, even for a Worker with no containers (none of ours has one). A wedged Docker daemon then
# blocks the build's event loop forever at 0% CPU (2026-10-31: a stuck `docker builder prune -af` hung three ship attempts of
# 569353e at "deploy ephem-load"). Bounded here (scripts/bounded.py: TERM, then KILL; the Go CLI ignores SIGALRM): after
# EPHEM_DOCKER_TIMEOUT_S (default 10) the call fails and wrangler skips its optional image cleanup. No docker on PATH: exit
# 127, the same outcome.
d=$(command -v docker) || {
  echo "docker-bounded: docker not on PATH" >&2
  exit 127
}
exec python3 "$(dirname "$0")/bounded.py" "${EPHEM_DOCKER_TIMEOUT_S:-10}" "docker $1 (wrangler build)" "$d" "$@"
