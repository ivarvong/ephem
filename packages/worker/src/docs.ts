// /docs (plain HTML, no JS needed), /llms.txt (plain text for agents) and /docs/interactive (Scalar, needs JS), from one
// endpoint table. Parameter lists come from QUERY_PARAMS and definitions from CONVENTIONS (both @ephem/api), so they cannot
// drift from the contract; test/docs.test.ts checks every parameter of every route is listed (round-2 feedback #7).
import { CONVENTIONS, PARAM_DOCS, QUERY_PARAMS } from "@ephem/api"
import { ICON_LINK } from "./favicon.ts"

export const BASE = "https://ephem.ivar.workers.dev"
export const SCALAR = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0"

interface Endpoint { readonly path: string; readonly question: string; readonly summary: string; readonly required: ReadonlyArray<string>; readonly example: string }
/** The three questions most people come with, answered by one copy-paste call each (docs/API.md opens with the same three). */
export const QUICKSTART: ReadonlyArray<{ readonly question: string; readonly path: string }> = [
  { question: "Where are the Sun and Moon right now?", path: "/position?lat=40.7&lon=-74" },
  { question: "When do they rise and set, and when is twilight, on a local day?", path: "/day?lat=40.7&lon=-74&date=2026-11-16&tz=America/New_York" },
  { question: "Where do I stand so the Moon sits on the Statue of Liberty?", path: "/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&height=5&heightRef=msl&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8" },
]
export const ENDPOINTS: ReadonlyArray<Endpoint> = [
  { path: "/position", question: "Where are the Sun and Moon at an instant?", summary: "Topocentric Sun and Moon at one instant (default now): azimuth, true and apparent altitude, rates, RA/Dec, distance, angular radius, Moon phase and bright limb (from celestial north and from the local vertical).",
    required: ["lat", "lon"], example: "/position?lat=40.7&lon=-74&time=2026-11-17T03:45:00Z" },
  { path: "/track", question: "What paths do they trace across the sky?", summary: "Sun and Moon azimuth, true and apparent altitude on a UTC grid (≤ 8 days, ≤ 1 441 samples), columnar; each sample equals /position at that instant.",
    required: ["lat", "lon", "start", "end"], example: "/track?lat=40.7&lon=-74&start=2026-11-16T00:00:00Z&end=2026-11-17T00:00:00Z" },
  { path: "/day", question: "What happens on a local day?", summary: "Rise, set, transit, civil / nautical / astronomical twilight, golden and blue hour for the Sun and Moon, sorted by time, with a conventions block (aim, horizon, dip, refraction, thresholds, geoid).",
    required: ["lat", "lon", "date", "tz"], example: "/day?lat=40.7&lon=-74&date=2026-11-16&tz=America/New_York" },
  { path: "/crossing", question: "When does a body reach a given altitude or skyline?", summary: "Every instant in a window (≤ 31 days) or a local date when the centre, a limb or the Moon's lit-area centroid (aim) reaches a true or apparent altitude, or a skyline profile.",
    required: ["lat", "lon", "body"], example: "/crossing?body=moon&lat=40.6985&lon=-73.999&height=5&heightRef=msl&altitude=0.87&altitudeType=apparent&direction=set&start=2026-11-16T00:00:00Z&end=2026-11-18T00:00:00Z" },
  { path: "/alignment", question: "Where do I stand so the body sits on a landmark?", summary: "Per instant, the standing point from which the Sun or Moon (centre, a limb, or the Moon's lit-area centroid: aim) sits on the target, with distance, bearing, rates and the eye's heights; with lat/lon (a fixed spot), also when it passes the target from there.",
    required: ["body", "targetLat", "targetLon", "targetHeight", "start", "end"], example: "/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&height=5&heightRef=msl&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8" },
  { path: "/sightline", question: "Does the line of sight to the landmark clear what is between us?", summary: "The sight line's height above sea level against ground distance from an eye to a target (Earth curvature; straight and refracted with k = 0.13), and the clearance over obstacle points lat:lon:heightMsl.",
    required: ["lat", "lon", "targetLat", "targetLon", "targetHeight"], example: "/sightline?lat=40.6935&lon=-74.0017&height=5&heightRef=msl&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&samples=11&obstacles=40.6894:-74.0166:25" },
  { path: "/magnetic", question: "What is the magnetic declination here?", summary: "WMM2025 declination (turn the true azimuths above into compass bearings), inclination and intensity.", required: ["lat", "lon"], example: "/magnetic?lat=40.7&lon=-74" },
  { path: "/weather", question: "What is the weather at the nearest stations?", summary: "Nearest METAR stations, decoded, with distance and true / magnetic bearing (temperature and pressure are the refraction inputs).", required: ["lat", "lon"], example: "/weather?lat=40.7&lon=-74&count=2" },
  { path: "/healthz", question: "Is it up?", summary: "Liveness.", required: [], example: "/healthz" },
]

const CONVENTION_KEYS: ReadonlyArray<keyof typeof CONVENTIONS> = ["frame", "trueAltitude", "apparentAltitude", "height", "rise", "crossing", "alignment", "aim", "passes", "rates", "brightLimb", "phase", "twilight", "goldenHour", "blueHour", "track", "sightline", "search", "supportedRange", "ut1", "magnetic", "weather", "unknownParameters"]
const RULES = [
  "Times are UTC ISO-8601 with a trailing Z (e.g. 2026-11-17T03:45:00Z); supported 1972-01-01 to 2149-12-31.",
  "Angles are degrees; azimuth from true north through east, [0, 360). Rates are degrees per minute.",
  "Heights are metres above the WGS-84 ellipsoid unless heightRef=msl (targetHeightRef=msl for an alignment target); without a height the observer is on the EGM96 geoid (sea level).",
  "Errors are JSON {_tag, message, parameter?, allowed?}: 400 InvalidRequest for anything wrong with the request (unknown, missing, malformed or out-of-range parameter, or an impossible combination; the message names the parameter, what was wrong and what is allowed); 503 Unavailable when a data source (geoid, METAR feed) fails; 404 NotFound lists the endpoints.",
  "Every response has conventions (every threshold, model, refraction input and height reference it used) and provenance (implementation, version, sources; blocks, compute time and cache tiers where it computed).",
  "One vocabulary everywhere: lat, lon, height, heightRef (you); targetLat, targetLon, targetHeight, targetHeightRef (the landmark); body; time, start, end, date, tz, stepSeconds; temperature, pressure, horizon, horizonProfile, dut1; aim; include. No version prefix.",
  "Deterministic answers (anything with an explicit time or window) are cached immutably; x-ephem-cache says HIT or MISS.",
]

/** The one POST route (JSON body; QUERY_PARAMS lists query routes only). */
export const SEARCH_POST = {
  path: "/alignment/search",
  question: "Every pass over an area I can stand in, over months",
  summary: "Every pass in [start, end) (≤ 400 days) when the alignment standing point lies inside a region you can stand in, with exact entry / exit per in-region segment and, per pass, the body's azimuth and apparent altitude, the Moon's illuminated fraction and the Sun's altitude. One call instead of crossing → alignment → polygon clip → position. The JSON body uses the same names as /alignment's query.",
  fields: "body*, targetLat*, targetLon*, targetHeight*, targetHeightRef, region* (GeoJSON Polygon | MultiPolygon | Feature, or bbox [west, south, east, north]), height, heightRef, start*, end*, temperature, pressure, dut1, aim, include (sun, phase or sun,phase), minIlluminated, maxSunAltitude",
  example: '{"body":"moon","targetLat":40.68925,"targetLon":-74.0445,"targetHeight":70,"targetHeightRef":"msl","region":[-73.9995,40.7,-73.993,40.706],"height":5,"heightRef":"msl","start":"2026-11-16T00:00:00Z","end":"2026-11-18T00:00:00Z","maxSunAltitude":-4}',
}
const params = (path: string, required: ReadonlyArray<string>) => (QUERY_PARAMS[path] ?? []).map(p => (required.includes(p) ? `${p}*` : p))

const PARAM_NAMES = Object.keys(PARAM_DOCS)

/** /llms.txt (llmstxt.org shape: H1, summary, sections of links / facts). */
export const llmsTxt = (): string => [
  "# ephem",
  "",
  "> The Sun and Moon from JPL DE440, as a JSON HTTP API and an MCP server: where they are, what they do on a day, when they reach an altitude, and where to stand so one sits on a landmark. Every answer is checked against an independent implementation (Skyfield for the sky, PROJ and GeographicLib for geometry, NOAA test values and pygeomag for the magnetic field) and states its conventions.",
  "",
  "## Start here",
  ...QUICKSTART.flatMap(q => [`- ${q.question}`, `  curl '${BASE}${q.path}'`]),
  "",
  "## Machine-readable",
  `- OpenAPI 3.1: ${BASE}/openapi.json`,
  `- MCP (Streamable HTTP, no auth): ${BASE}/mcp (one tool per endpoint, same names: position, track, day, crossing, alignment, alignment_search, sightline, magnetic, weather; each takes the same arguments and returns the same JSON)`,
  `- Human docs (plain HTML): ${BASE}/docs`,
  `- Page for people: ${BASE}/ (live sky; ?lat&lon&tz override the location)`,
  "",
  "## Rules",
  ...RULES.map(r => `- ${r}`),
  "",
  "## Endpoints (one question each; GET unless noted; * = required)",
  ...ENDPOINTS.flatMap(e => [`- ${e.path}: ${e.question} ${e.summary}`, `  params: ${params(e.path, e.required).join(", ") || "none"}`, `  example: ${BASE}${e.example}`,
    ...(e.path === "/alignment" ? [`- POST ${SEARCH_POST.path}: ${SEARCH_POST.question}. ${SEARCH_POST.summary}`, `  fields: ${SEARCH_POST.fields}`, `  example: curl -X POST -H 'content-type: application/json' ${BASE}${SEARCH_POST.path} -d '${SEARCH_POST.example}'`] : [])]),
  "",
  "## Parameters (the same meaning on every endpoint)",
  ...PARAM_NAMES.map(k => `- ${k}: ${PARAM_DOCS[k]}`),
  "",
  "## Conventions",
  ...CONVENTION_KEYS.map(k => `- ${k}: ${CONVENTIONS[k]}`),
  "",
].join("\n")

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const endpointHtml = (e: Endpoint) => `<dt><code>${e.path}</code></dt><dd><strong>${esc(e.question)}</strong> ${esc(e.summary)}<br>Parameters: <code>${params(e.path, e.required).join(", ") || "none"}</code><br>Example: <a href="${esc(e.example)}"><code>${esc(e.example)}</code></a></dd>`
const searchHtml = `<dt><code>POST ${SEARCH_POST.path}</code></dt><dd><strong>${esc(SEARCH_POST.question)}.</strong> ${esc(SEARCH_POST.summary)}<br>JSON body: <code>${esc(SEARCH_POST.fields)}</code><br>Example: <code>curl -X POST -H 'content-type: application/json' ${BASE}${SEARCH_POST.path} -d '${esc(SEARCH_POST.example)}'</code></dd>`
/** /docs: readable without JavaScript; opens with three copy-paste calls, then every endpoint, parameter and convention. */
export const docsHtml = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ICON_LINK}<title>ephem API</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}code,pre{font:13px ui-monospace,monospace;background:#f3f3f3;padding:0 .2em;overflow-wrap:anywhere}pre{padding:.6em .8em;white-space:pre-wrap}h2{margin-top:2rem}dt{margin-top:1rem;font-weight:600}dd{margin:.2rem 0 0 1rem}@media(prefers-color-scheme:dark){body{color:#eee;background:#111}code,pre{background:#222}a{color:#8bf}}</style></head><body>
<h1>ephem API</h1>
<p>The Sun and Moon from JPL DE440: where they are, what they do on a day, when they reach an altitude, and where to stand so one sits on a landmark. JSON over HTTPS, CORS open, no key. Every answer is checked against an independent implementation (Skyfield for the sky, PROJ and GeographicLib for geometry, NOAA test values and pygeomag for the magnetic field) and states the conventions it used.</p>
${QUICKSTART.map(q => `<p><strong>${esc(q.question)}</strong></p><pre>curl '${esc(BASE + q.path)}'</pre>`).join("\n")}
<ul>
<li>OpenAPI 3.1 spec: <a href="/openapi.json"><code>/openapi.json</code></a></li>
<li>For agents: <a href="/llms.txt"><code>/llms.txt</code></a> · MCP server: <code>${BASE}/mcp</code> (Streamable HTTP; one tool per endpoint, same names and arguments)</li>
<li>Interactive reference (needs JavaScript): <a href="/docs/interactive"><code>/docs/interactive</code></a></li>
<li>Page: <a href="/">the live sky</a> (<code>?lat&amp;lon&amp;tz</code> override the location)</li>
</ul>
<h2>Rules</h2><ul>${RULES.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
<h2>Endpoints</h2><p>One question each. GET unless noted. <code>*</code> = required.</p><dl>${ENDPOINTS.map(e => endpointHtml(e) + (e.path === "/alignment" ? searchHtml : "")).join("")}</dl>
<h2>Parameters</h2><p>The same name means the same thing on every endpoint.</p><dl>${PARAM_NAMES.map(k => `<dt><code>${k}</code></dt><dd>${esc(PARAM_DOCS[k]!)}</dd>`).join("")}</dl>
<h2>Conventions</h2><dl>${CONVENTION_KEYS.map(k => `<dt>${k}</dt><dd>${esc(CONVENTIONS[k])}</dd>`).join("")}</dl>
</body></html>`

export const SCALAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${ICON_LINK}<title>ephem API reference</title></head><body><noscript>This page needs JavaScript; <a href="/docs">/docs</a> is plain HTML and <a href="/openapi.json">/openapi.json</a> the spec.</noscript><script id="api-reference" data-url="/openapi.json"></script><script src="${SCALAR}"></script></body></html>`
