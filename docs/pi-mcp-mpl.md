# Compose ephem MCP, mpl, and pi

This recipe asks [ephem's public MCP endpoint](https://ephem.ivar.workers.dev/mcp) for daily sunsets, plots them with [mpl](https://github.com/ivarvong/mpl), and asks [pi](https://github.com/badlogic/pi-mono) to inspect the PNG inline. The checked-in SVG is an example output, not a byte-exact promise from the compact script.

![Outlined SVG line chart of Tokyo sunset times during November 2026](images/tokyo-sunset-november-2026.svg)

The example requests Central Tokyo (`35.6762° N, 139.6503° E`) for local dates November 1–30, 2026 in `Asia/Tokyo`: height `0 m` MSL, standard sea horizon, upper solar limb, `10 °C`, `1010 hPa`, and DUT1 `0 s`. It produced 16:46:35 JST on November 1 and 16:28:19 JST on November 30. These are theoretical JPL DE440 predictions, not observed visibility; terrain, weather, and unusual refraction can change what a person sees.

## Discover the MCP API

MCP is JSON-RPC over HTTP here. These calls show initialization, the live `day` schema, and one real request rather than relying on a copied client:

```sh
EPHEM=https://ephem.ivar.workers.dev/mcp
HDR=(-H 'content-type: application/json' -H 'accept: application/json,text/event-stream')
curl -sS "$EPHEM" "${HDR[@]}" --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"chart-recipe","version":"1"}}}'
curl -sS "$EPHEM" "${HDR[@]}" --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' > tools.json
node -e 'let j=require("./tools.json"); console.log(j.result.tools.find(t=>t.name==="day").inputSchema)'
curl -sS "$EPHEM" "${HDR[@]}" --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"day","arguments":{"lat":35.6762,"lon":139.6503,"date":"2026-11-01","tz":"Asia/Tokyo","height":0,"heightRef":"msl","horizon":"sea","aim":"upper","temperature":10,"pressure":1010,"dut1":0}}}'
```

At publication, `tools/list` required `lat`, `lon`, `date`, and `tz`; the script below verifies those fields and every optional argument before making 30 sequential calls. A tool result's JSON payload is in `result.content[].text`.

## Fetch and plot with Node 24

Pin mpl's official source in a cache. mpl runs directly from TypeScript source: no npm install or build step.

```sh
PIN=c638db3d465be0c5af6c364c60e58fdf1195d51e
export MPL_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/mpl/$PIN"
mkdir -p "$(dirname "$MPL_ROOT")"
test -d "$MPL_ROOT/.git" || git clone --no-checkout https://github.com/ivarvong/mpl.git "$MPL_ROOT"
git -C "$MPL_ROOT" fetch --depth=1 origin "$PIN"
git -C "$MPL_ROOT" checkout --detach FETCH_HEAD
```

Save this as `chart.mjs`, then run `node chart.mjs`. It writes `tokyo-sunset.png` for pi and an outlined, font-independent `tokyo-sunset.svg` for publication.

```js
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const endpoint = "https://ephem.ivar.workers.dev/mcp"
const query = { lat: 35.6762, lon: 139.6503, tz: "Asia/Tokyo", height: 0,
  heightRef: "msl", horizon: "sea", aim: "upper", temperature: 10, pressure: 1010, dut1: 0 }
let id = 0
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json,text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  const message = await response.json()
  if (message.error) throw new Error(message.error.message)
  return { result: message.result, version: response.headers.get("x-ephem-version") }
}
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {},
  clientInfo: { name: "chart-recipe", version: "1" } })
const listed = await rpc("tools/list")
const dayTool = listed.result.tools.find((tool) => tool.name === "day")
const required = ["lat", "lon", "date", "tz"]
const accepts = ([key, value]) => { const field = dayTool?.inputSchema.properties[key]
  return field && (!field.enum || field.enum.includes(value)) }
if (!dayTool || required.some((key) => !dayTool.inputSchema.required.includes(key)) ||
    !Object.entries(query).every(accepts)) throw new Error("day schema changed")

const clock = new Intl.DateTimeFormat("en-GB", { timeZone: query.tz, hour: "2-digit",
  minute: "2-digit", second: "2-digit", hourCycle: "h23" })
const rows = []
for (let day = 1; day <= 30; day++) {
  const date = `2026-11-${String(day).padStart(2, "0")}`
  const reply = await rpc("tools/call", { name: "day", arguments: { ...query, date } })
  const text = reply.result.content.find((item) => item.type === "text")?.text
  const data = JSON.parse(text)
  const sunset = data.events.find((event) => event.body === "sun" && event.kind === "set")
  const [h, m, s] = clock.format(new Date(sunset.time)).split(":").map(Number)
  rows.push({ day, minutes: h * 60 + m + s / 60, local: clock.format(new Date(sunset.time)),
    utc: sunset.time, ephemVersion: reply.version })
}

const mpl = await import(pathToFileURL(join(process.env.MPL_ROOT, "src/index.ts")))
const [fig, ax] = mpl.subplots({ figsize: [10, 6], dpi: 160, rc: {
  "figure.facecolor": "#faf9f6", "axes.facecolor": "#faf9f6", "axes.grid": true,
  "grid.color": "#dedcd5", "axes.spines.top": false, "axes.spines.right": false } })
ax.plot(rows.map((r) => r.day), rows.map((r) => r.minutes), "-o",
  { color: "#d85b24", linewidth: 2, markersize: 4 })
ax.set_xlabel("November 2026 (day)")
ax.set_ylabel("Sunset in Asia/Tokyo (minutes after midnight)")
ax.set_title("Tokyo sunset")
const scene = fig.toScene()
await writeFile("tokyo-sunset.png", fig.toPNGSync())
await writeFile("tokyo-sunset.svg", mpl.toSVG(scene, mpl.tracer, "glyphs"))
await writeFile("tokyo-sunset-data.json", JSON.stringify({ endpoint, query, rows }, null, 2))
console.log(rows[0], rows.at(-1))
```

Keep the JSON beside the chart: it records the endpoint, exact query, UTC instants, local labels, and `x-ephem-version`. A fresh run may use a newer ephem version than the checked-in example (`26420080-0963-4a89-b441-aa71813d01a6`).

## Let pi orchestrate it

Pi can follow the public APIs directly. If you want reusable instructions, create instruction-only skills (for example under `$HOME/.agents/skills`) and reload pi; no helper scripts are required.

```md
---
name: ephem
summary: Query the public ephem MCP endpoint for Sun and Moon data.
---
Initialize MCP, inspect `tools/list`, validate the selected tool schema, then call it. Preserve the exact arguments, UTC instants, conventions, and `x-ephem-version`; label theoretical predictions.
```

```md
---
name: mpl
summary: Plot data with the zero-dependency mpl JavaScript source API.
---
Use Node 24 and a pinned checkout of https://github.com/ivarvong/mpl. Save PNG with `Figure.toPNGSync()` and outlined SVG with exported `toSVG(fig.toScene(), tracer, "glyphs")`; ask pi to read the PNG and inspect clipping and labels.
```

Then prompt pi: “Use ephem MCP to plot Tokyo sunset times for November 2026 with mpl, retain provenance, and read the PNG inline.” Pi's `read` tool displays the PNG so the chart can be checked before publishing the SVG.
