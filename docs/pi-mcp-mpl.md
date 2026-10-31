# From ephemeris data to an inline chart in pi

This guide builds a reproducible chart of daily sunset times in Central Tokyo. It uses three small pieces with clear boundaries:

1. **ephem MCP → data** — a zero-dependency Node.js client discovers the live MCP tools, fetches one `day` result per local date, and retains every response envelope.
2. **data → render** — a pinned mpl loader turns the retained `derived.json` into matching PNG and font-independent, outlined-text SVG artifacts.
3. **render → pi** — pi reads the PNG with its image-aware `read` tool, displaying the result inline for visual inspection.

![Line chart of Tokyo sunset times for November 2026, declining from 16:46:35 JST on November 1 to 16:28:19 JST on November 30](images/tokyo-sunset-november-2026.svg)

The first endpoint is **16:46:35 JST on November 1** and the last is **16:28:19 JST on November 30**, a decrease of **18 minutes 16 seconds**. These values are stated outside the image so the result remains available to readers who cannot inspect the chart.

The checked-in image was derived from ephem source version `26420080-0963-4a89-b441-aa71813d01a6` and rendered with mpl revision `c638db3d465be0c5af6c364c60e58fdf1195d51e`.

## Requirements

- [pi](https://github.com/badlogic/pi-mono) with its coding-agent skill support
- Node.js 24 or newer
- Git and network access for the first mpl load
- Network access to fetch fresh ephem MCP data; a retained `derived.json` is enough for an offline rerender

No npm install is needed. The example carries its Node client and both skill bundles with it.

## Install the skills

Clone this repository, then copy the example's `ephem` and `mpl` directories into pi's user skill directory:

```sh
git clone https://github.com/ivarvong/ephem.git
cd ephem/docs/examples/pi-mcp-mpl
mkdir -p "$HOME/.agents/skills"
cp -R ephem mpl "$HOME/.agents/skills/"
```

Enter `/reload` in pi so it discovers the two `SKILL.md` files. There is deliberately no native MCP configuration: the ephem skill invokes its bundled Node client, which makes stateless JSON-RPC requests over HTTP and preserves the complete exchange.

You can inspect discovery directly:

```sh
node "$HOME/.agents/skills/ephem/scripts/mcp.mjs" initialize
node "$HOME/.agents/skills/ephem/scripts/mcp.mjs" tools/list
```

The fetch script performs those same calls before any tool call and checks the live `day` input schema rather than assuming it.

## Fetch and render

Choose an output directory outside the clone and run the example:

```sh
OUT="${XDG_CACHE_HOME:-$HOME/.cache}/ephem/tasks/tokyo-sunset"
node "$HOME/.agents/skills/ephem/scripts/tokyo-sunset.mjs" --out "$OUT"
```

The live run uses at most three concurrent requests. Its assumptions are explicit:

| Field | Value |
| --- | --- |
| Location | Central Tokyo, WGS-84 `35.6762, 139.6503` |
| Local dates | `2026-11-01` through `2026-11-30` |
| Time zone | `Asia/Tokyo` |
| Height | `0` m, `msl` |
| Horizon and limb | `sea`, `upper` |
| Refraction inputs | `10 °C`, `1010 hPa` |
| DUT1 | `0` s |

The output is an audit-friendly working set:

```text
initialize.json                 complete MCP initialization envelope
tools-list.json                 complete tool-discovery envelope
raw/day-2026-11-01.json         complete tool-call envelope (one per date)
…
derived.json                    compact retained data used by the renderer
tokyo-sunset-november-2026.png  raster chart
tokyo-sunset-november-2026.svg  vector chart
tokyo-sunset-november-2026.metadata.json
```

Complete envelopes preserve the outgoing arguments, HTTP response status and headers, raw JSON-RPC response, parsed tool result, error state, trace identifier, and `x-ephem-version`. `derived.json` additionally retains the live schema, query, source versions, returned observer and convention blocks, UTC event instants, and local labels.

When the command finishes, give pi the absolute PNG path and ask it to read the image, for example:

> Read `/absolute/path/to/tokyo-sunset-november-2026.png` and check the chart for clipping, collisions, and misleading labels.

Pi's `read` tool displays the PNG inline. The SVG is the publication artifact: the example calls mpl's exported `toSVG(fig.toScene(), tracer, "glyphs")` renderer, whose pinned source API emits reusable glyph outlines in `<defs>` and `<use>` elements rather than font-dependent `<text>` elements.

## Rerender offline

Rendering is intentionally separable from collection. Supply any retained derivation produced by this example:

```sh
node "$HOME/.agents/skills/ephem/scripts/tokyo-sunset.mjs" \
  --derived /path/to/derived.json \
  --out /tmp/tokyo-sunset-rerender
```

This mode makes no MCP requests. It validates the Tokyo query and date range, copies the supplied derivation into the new output directory, and regenerates the PNG, SVG, and metadata. Once the exact mpl revision is present in its cache, rerendering also works without network access.

## Reproducibility and provenance

The example pins the renderer by both Git revision and a digest of its runtime source tree. On first use, `mpl/load.mjs` fetches revision `c638db3d465be0c5af6c364c60e58fdf1195d51e` into a revision-specific cache and validates it before import. Later runs validate the cache again. Set `MPL_ROOT=/absolute/path` only to use a clean checkout at that exact revision; the loader rejects a dirty or mismatched checkout.

The checked-in image's data came from ephem version `26420080-0963-4a89-b441-aa71813d01a6`. A fresh fetch may report a newer `x-ephem-version`; that is expected and remains visible in its envelopes, `derived.json`, and metadata. For a byte-stable investigation, retain the original `derived.json` and rerender it with the pinned mpl revision instead of silently refetching.

Dates in a `day` request are **local calendar dates**, while returned event times are UTC instants. The script converts each instant with `Intl.DateTimeFormat` and the IANA zone `Asia/Tokyo`. Do not derive local time by adding a remembered UTC offset: IANA rules encode historical and future daylight-saving transitions, and many month-long plots cross an offset change even though Tokyo does not in this interval.

Finally, these are theoretical JPL DE440 ephemeris predictions under the stated horizon and refraction assumptions. They are not observations or guarantees of visibility. Local terrain and skyline, clouds, aerosols, and atmospheric gradients can obscure or shift the sunset a viewer experiences.
