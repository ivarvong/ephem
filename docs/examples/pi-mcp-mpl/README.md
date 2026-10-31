# pi + ephem MCP + mpl example

This directory is self-contained: the two child directories are installable pi skills, and the ephem skill contains a zero-dependency Node.js 24 MCP client plus the Tokyo fetch/render script. The mpl loader is pinned to `c638db3d465be0c5af6c364c60e58fdf1195d51e`.

```sh
mkdir -p "$HOME/.agents/skills"
cp -R ephem mpl "$HOME/.agents/skills/"
# Enter /reload in pi, then:
OUT="${XDG_CACHE_HOME:-$HOME/.cache}/ephem/tokyo-sunset"
node "$HOME/.agents/skills/ephem/scripts/tokyo-sunset.mjs" --out "$OUT"
```

Offline rerender from an existing derivation:

```sh
node ./ephem/scripts/tokyo-sunset.mjs \
  --derived /path/to/derived.json \
  --out /tmp/tokyo-sunset-rerender
```

The output directory contains `derived.json`, provenance metadata, and matching `tokyo-sunset-november-2026.png` and `.svg` files. A live run additionally retains initialization, tool discovery, and all 30 raw MCP envelopes.
