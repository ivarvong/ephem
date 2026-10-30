// /docs (plain HTML, no JS needed), /llms.txt (plain text for agents) and /docs/interactive (Scalar, needs JS), from one
// endpoint table. Parameter lists come from QUERY_PARAMS and definitions from CONVENTIONS (both @ephem/api), so they cannot
// drift from the contract; test/docs.test.ts checks every parameter of every route is listed (round-2 feedback #7).
import { CONVENTIONS, QUERY_PARAMS } from "@ephem/api"

export const BASE = "https://ephem.ivar.workers.dev"
export const SCALAR = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0"

interface Endpoint { readonly path: string; readonly summary: string; readonly required: ReadonlyArray<string>; readonly example: string }
export const ENDPOINTS: ReadonlyArray<Endpoint> = [
  { path: "/v1/position", summary: "Topocentric Sun and Moon at one instant (default now): azimuth, true and apparent altitude, rates, RA/Dec, distance, angular radius, Moon phase and bright limb (from celestial north and from the local vertical).",
    required: ["lat", "lon"], example: "/v1/position?lat=40.7&lon=-74&time=2026-11-17T03:45:00Z" },
  { path: "/v1/day", summary: "One local day's events: rise, set, transit, civil/nautical/astronomical twilight, golden and blue hour, with a conventions block (limb, horizon, dip, refraction, thresholds, geoid).",
    required: ["lat", "lon", "date", "tz"], example: "/v1/day?lat=40.7&lon=-74&date=2026-11-16&tz=America/New_York" },
  { path: "/v1/crossing", summary: "Every instant in a window (≤ 31 days) or local date when a limb, the centre or the lit-area centroid (aim) of the Sun or Moon reaches a true or apparent altitude or a skyline profile.",
    required: ["lat", "lon", "body"], example: "/v1/crossing?body=moon&lat=40.6985&lon=-73.999&height=5&heightRef=msl&altitude=0.87&altitudeType=apparent&direction=set&start=2026-11-16T00:00:00Z&end=2026-11-18T00:00:00Z" },
  { path: "/v1/alignment", summary: "Where to stand so the Sun or Moon (centre, a limb, or the Moon's lit-area centroid: aim) sits on a landmark, per instant; with observerLat/Lon also when it passes the landmark from a fixed spot. Heights in ellipsoid or msl (heightRef, targetHeightRef), per-point rates, include=sun,phase.",
    required: ["body", "targetLat", "targetLon", "targetHeight", "start", "end"], example: "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&observerHeight=5&heightRef=msl&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8" },
  { path: "/v1/sightline", summary: "The sight line's height above sea level against ground distance from an eye to a target (Earth curvature; straight and refracted with k = 0.13), and the clearance over obstacle points lat:lon:heightMsl.",
    required: ["observerLat", "observerLon", "targetLat", "targetLon", "targetHeight"], example: "/v1/sightline?observerLat=40.6935&observerLon=-74.0017&observerHeight=5&heightRef=msl&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&samples=11&obstacles=40.6894:-74.0166:25" },
  { path: "/v1/track", summary: "Sun and Moon azimuth, true and apparent altitude on a UTC grid (≤ 8 days, ≤ 1 441 samples), columnar.",
    required: ["lat", "lon", "start", "end"], example: "/v1/track?lat=40.7&lon=-74&start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z" },
  { path: "/v1/magnetic", summary: "WMM2025 magnetic declination, inclination and intensity.", required: ["lat", "lon"], example: "/v1/magnetic?lat=40.7&lon=-74" },
  { path: "/v1/weather", summary: "Nearest METAR stations, decoded, with distance and true/magnetic bearing.", required: ["lat", "lon"], example: "/v1/weather?lat=40.7&lon=-74&n=2" },
  { path: "/healthz", summary: "Liveness.", required: [], example: "/healthz" },
]

const CONVENTION_KEYS: ReadonlyArray<keyof typeof CONVENTIONS> = ["frame", "trueAltitude", "apparentAltitude", "height", "rise", "crossing", "alignment", "aim", "passes", "rates", "brightLimb", "phase", "twilight", "goldenHour", "blueHour", "track", "sightline", "supportedRange", "ut1", "magnetic", "weather", "unknownParameters"]
const RULES = [
  "Times are UTC ISO-8601 with a trailing Z (e.g. 2026-11-17T03:45:00Z); supported 1972-01-01 to 2149-12-31.",
  "Angles are degrees; azimuth from true north through east, [0, 360). Rates are degrees per minute.",
  "Heights are metres above the WGS-84 ellipsoid unless heightRef=msl (targetHeightRef=msl for an alignment target); without a height the observer is on the EGM96 geoid (sea level).",
  "Unknown query parameters are rejected with 400 InvalidRequest listing the allowed ones. Errors are JSON with a _tag (InvalidRequest 400, InvalidInput / OutOfRange 422, GeoidUnavailable / WeatherUnavailable 503).",
  "Every data response has provenance (ephemeris, blocks, compute time, cache tiers); position, day, crossing, alignment and track have a conventions block stating every threshold, refraction and height reference used.",
  "Deterministic answers (anything with an explicit time or window) are cached immutably; x-ephem-cache says HIT or MISS.",
]

const params = (path: string, required: ReadonlyArray<string>) => (QUERY_PARAMS[path] ?? []).map(p => (required.includes(p) ? `${p}*` : p))

/** /llms.txt (llmstxt.org shape: H1, summary, sections of links / facts). */
export const llmsTxt = (): string => [
  "# ephem",
  "",
  "> Sun and Moon positions, day events, altitude crossings and landmark alignments computed from JPL DE440, served as a JSON HTTP API and an MCP server. Deterministic, cross-checked against Skyfield.",
  "",
  "## Machine-readable",
  `- OpenAPI 3.1: ${BASE}/openapi.json`,
  `- MCP (Streamable HTTP, no auth): ${BASE}/mcp (tools: sun_moon_position, day_events, crossing, alignment, sight_line, sun_moon_track, weather_nearest; each returns the same JSON as its REST route)`,
  `- Human docs (plain HTML): ${BASE}/docs`,
  "",
  "## Rules",
  ...RULES.map(r => `- ${r}`),
  "",
  "## Endpoints (GET; * = required)",
  ...ENDPOINTS.flatMap(e => [`- ${e.path}: ${e.summary}`, `  params: ${params(e.path, e.required).join(", ") || "none"}`, `  example: ${BASE}${e.example}`]),
  "",
  "## Conventions",
  ...CONVENTION_KEYS.map(k => `- ${k}: ${CONVENTIONS[k]}`),
  "",
].join("\n")

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/** /docs: readable without JavaScript; links the spec, llms.txt, MCP and the interactive reference. */
export const docsHtml = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ephem API</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}code{font:13px ui-monospace,monospace;background:#f3f3f3;padding:0 .2em;overflow-wrap:anywhere}h2{margin-top:2rem}dt{margin-top:1rem;font-weight:600}dd{margin:.2rem 0 0 1rem}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}code{background:#222}a{color:#8bf}}</style></head><body>
<h1>ephem API</h1>
<p>Sun and Moon positions, day events, crossings and landmark alignments from JPL DE440. JSON over HTTPS, CORS open, no key.</p>
<ul>
<li>OpenAPI 3.1 spec: <a href="/openapi.json"><code>/openapi.json</code></a></li>
<li>For agents: <a href="/llms.txt"><code>/llms.txt</code></a> · MCP server: <code>${BASE}/mcp</code> (Streamable HTTP)</li>
<li>Interactive reference (needs JavaScript): <a href="/docs/interactive"><code>/docs/interactive</code></a></li>
</ul>
<h2>Rules</h2><ul>${RULES.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
<h2>Endpoints</h2><p>All GET. <code>*</code> = required.</p><dl>${ENDPOINTS.map(e => `<dt><code>${e.path}</code></dt><dd>${esc(e.summary)}<br>Parameters: <code>${params(e.path, e.required).join(", ") || "none"}</code><br>Example: <a href="${esc(e.example)}"><code>${esc(e.example)}</code></a></dd>`).join("")}</dl>
<h2>Conventions</h2><dl>${CONVENTION_KEYS.map(k => `<dt>${k}</dt><dd>${esc(CONVENTIONS[k])}</dd>`).join("")}</dl>
</body></html>`

export const SCALAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ephem API reference</title></head><body><noscript>This page needs JavaScript; <a href="/docs">/docs</a> is plain HTML and <a href="/openapi.json">/openapi.json</a> the spec.</noscript><script id="api-reference" data-url="/openapi.json"></script><script src="${SCALAR}"></script></body></html>`
