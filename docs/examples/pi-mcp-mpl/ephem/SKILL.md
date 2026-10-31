---
name: ephem
description: Query the live ephem MCP server for Sun and Moon ephemerides, preserve provenance, and render the bundled Tokyo sunset example with mpl.
compatibility: Requires Node.js 24+ and network access; rendering also requires the bundled mpl skill and Git on first use.
---

# ephem MCP

Use `scripts/mcp.mjs`, a zero-dependency MCP-over-HTTP client for `https://ephem.ivar.workers.dev/mcp`. There is no token. Always call `initialize` and `tools/list`, inspect the live input schema, and only then call a tool. Keep the complete returned envelopes: they contain the request, response, headers, trace, and `x-ephem-version` provenance.

```sh
node "$HOME/.agents/skills/ephem/scripts/mcp.mjs" initialize
node "$HOME/.agents/skills/ephem/scripts/mcp.mjs" tools/list
node "$HOME/.agents/skills/ephem/scripts/tokyo-sunset.mjs" --out /tmp/tokyo-sunset
```

The Tokyo script uses bounded concurrency (3), writes discovery and per-day envelopes, retains `derived.json`, and writes matching PNG and SVG charts. To rerender without network calls:

```sh
node "$HOME/.agents/skills/ephem/scripts/tokyo-sunset.mjs" \
  --derived /path/to/derived.json --out /tmp/tokyo-rerender
```

Event timestamps are UTC instants. Convert them to local civil time with `Intl.DateTimeFormat` and the query's IANA zone; never hard-code an offset because DST rules vary by zone and date. Preserve each result's observer, conventions, and sources. Ephemerides are theoretical predictions, not observations or visibility guarantees: terrain, skyline, clouds, and atmospheric conditions can change what is seen.
