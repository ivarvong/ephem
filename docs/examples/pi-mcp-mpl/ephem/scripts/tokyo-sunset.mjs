#!/usr/bin/env node
/** Fetch Tokyo sunsets through ephem MCP, or rerender a supplied derived.json. */
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mcpCallTool, mcpInitialize, mcpListTools } from "./mcp.mjs"

const EPHEM_VERSION = "26420080-0963-4a89-b441-aa71813d01a6"
const ENDPOINT = process.env.EPHEM_MCP_URL ?? "https://ephem.ivar.workers.dev/mcp"
const QUERY = Object.freeze({
  name: "Central Tokyo",
  lat: 35.6762,
  lon: 139.6503,
  tz: "Asia/Tokyo",
  startDate: "2026-11-01",
  endDate: "2026-11-30",
  height: 0,
  heightRef: "msl",
  horizon: "sea",
  aim: "upper",
  temperature: 10,
  pressure: 1010,
  dut1: 0,
})
const dates = Array.from({ length: 30 }, (_, index) => `2026-11-${String(index + 1).padStart(2, "0")}`)

function argumentsFrom(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--out") options.outDir = resolve(argv[++index])
    else if (argv[index] === "--derived") options.derived = resolve(argv[++index])
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.outDir) throw new Error("Usage: tokyo-sunset.mjs --out DIR [--derived FILE]")
  return options
}

const message = (envelope) => (Array.isArray(envelope.raw) ? envelope.raw.at(-1) : envelope.raw)
const unwrap = (envelope) => {
  const text = envelope.result?.content?.find((item) => item.type === "text")?.text
  if (!text) throw new Error("day result has no JSON text content")
  return JSON.parse(text)
}
const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: QUERY.tz,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})
const offset = new Intl.DateTimeFormat("en-GB", { timeZone: QUERY.tz, timeZoneName: "shortOffset" })
function minuteOfDay(instant) {
  const parts = Object.fromEntries(
    clock
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  )
  return parts.hour * 60 + parts.minute + parts.second / 60
}

async function fetchData(outDir) {
  await mkdir(join(outDir, "raw"), { recursive: true })

  // MCP discovery precedes every tool call; both complete envelopes are retained.
  const initialized = await mcpInitialize(ENDPOINT)
  await writeFile(join(outDir, "initialize.json"), `${JSON.stringify(initialized, null, 2)}\n`)
  const listed = await mcpListTools(ENDPOINT)
  await writeFile(join(outDir, "tools-list.json"), `${JSON.stringify(listed, null, 2)}\n`)
  const dayTool = message(listed)?.result?.tools?.find((tool) => tool.name === "day")
  if (!dayTool) throw new Error("Live tools/list has no day tool")
  for (const key of ["lat", "lon", "date", "tz"]) {
    if (!dayTool.inputSchema?.required?.includes(key)) throw new Error(`Live day schema does not require ${key}`)
  }
  for (const [key, value] of Object.entries(QUERY).filter(([key]) => !["name", "startDate", "endDate"].includes(key))) {
    const property = dayTool.inputSchema?.properties?.[key]
    if (!property) throw new Error(`Live day schema has no ${key}`)
    if (property.enum && !property.enum.includes(value)) throw new Error(`Live day schema rejects ${key}=${value}`)
  }

  const envelopes = new Map()
  let next = 0
  async function worker() {
    while (next < dates.length) {
      const index = next++
      const date = dates[index]
      const request = {
        lat: QUERY.lat,
        lon: QUERY.lon,
        date,
        tz: QUERY.tz,
        height: QUERY.height,
        heightRef: QUERY.heightRef,
        horizon: QUERY.horizon,
        aim: QUERY.aim,
        temperature: QUERY.temperature,
        pressure: QUERY.pressure,
        dut1: QUERY.dut1,
      }
      const envelope = await mcpCallTool("day", request, ENDPOINT, 1000 + index)
      envelopes.set(date, envelope)
      await writeFile(join(outDir, "raw", `day-${date}.json`), `${JSON.stringify(envelope, null, 2)}\n`)
    }
  }
  await Promise.all(Array.from({ length: 3 }, () => worker()))

  const versions = new Set()
  const conventionsByDate = {}
  const observersByDate = {}
  const sourcesByDate = {}
  const rows = dates.map((date) => {
    const envelope = envelopes.get(date)
    if (envelope.provenance?.ephemVersion) versions.add(envelope.provenance.ephemVersion)
    const day = unwrap(envelope)
    conventionsByDate[date] = day.conventions
    observersByDate[date] = day.observer
    sourcesByDate[date] = day.provenance?.sources
    const sunset = day.events?.find((event) => event.body === "sun" && event.kind === "set")
    if (!sunset) throw new Error(`Missing sunset for ${date}`)
    return {
      date,
      sunsetUtc: sunset.time,
      sunsetLocal: clock.format(new Date(sunset.time)),
      sunsetMinutes: minuteOfDay(sunset.time),
      utcOffset: offset.formatToParts(new Date(sunset.time)).find((part) => part.type === "timeZoneName")?.value,
      event: sunset,
    }
  })
  return {
    generatedAt: new Date().toISOString(),
    endpoint: ENDPOINT,
    liveDaySchema: dayTool.inputSchema,
    query: QUERY,
    interpretation:
      "Local dates and clock labels use Asia/Tokyo via Intl; sunset is the returned Sun set event. Theoretical ephemeris, not an observation or visibility forecast.",
    versions: [...versions],
    conventionsByDate,
    observersByDate,
    sourcesByDate,
    rows,
  }
}

function validate(data) {
  if (data.query?.lat !== QUERY.lat || data.query?.lon !== QUERY.lon || data.query?.tz !== QUERY.tz) {
    throw new Error("Expected the Central Tokyo / Asia/Tokyo dataset")
  }
  for (const key of ["height", "heightRef", "horizon", "aim", "temperature", "pressure", "dut1"]) {
    if (data.query[key] !== QUERY[key]) throw new Error(`Unexpected query.${key}: ${data.query[key]}`)
  }
  if (data.rows?.length !== 30 || data.rows[0]?.date !== QUERY.startDate || data.rows.at(-1)?.date !== QUERY.endDate) {
    throw new Error("Expected one row per day from 2026-11-01 through 2026-11-30")
  }
}

async function render(data, sourceBytes, outDir) {
  validate(data)
  const bundledMpl = fileURLToPath(new URL("../../mpl", import.meta.url))
  const mplDir = process.env.MPL_SKILL_DIR ?? bundledMpl
  const importSkill = (name) => import(pathToFileURL(join(mplDir, name)).href)
  const [{ loadMpl }, { saveFigure }, { cleanLight, cleanLightColors, addEditorialFrame }] = await Promise.all([
    importSkill("load.mjs"),
    importSkill("save.mjs"),
    importSkill("design.mjs"),
  ])
  const loaded = await loadMpl()
  const x = data.rows.map((row) => new Date(`${row.date}T12:00:00Z`))
  const y = data.rows.map((row) => row.sunsetMinutes)
  const first = data.rows[0]
  const last = data.rows.at(-1)
  const [fig, ax] = loaded.mpl.subplots({ rc: cleanLight, figsize: [10, 7], dpi: 160 })
  ax.plot(x, y, "-", { color: cleanLightColors.accent, linewidth: 2.25 })
  for (const index of [0, x.length - 1]) {
    ax.plot([x[index]], [y[index]], "o", {
      color: cleanLightColors.accent,
      markersize: 7,
      markerfacecolor: cleanLightColors.accent,
      markeredgecolor: cleanLightColors.surface,
    })
  }
  const tickDays = [1, 5, 10, 15, 20, 25, 30]
  ax.set_xticks(tickDays.map((day) => new Date(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`)))
  ax.set_xticklabels(tickDays.map((day) => String(day).padStart(2, "0")))
  const yTicks = [990, 995, 1000, 1005]
  ax.set_yticks(yTicks)
  ax.set_yticklabels(yTicks.map((value) => `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`))
  ax.set_ylim(987, 1008)
  ax.grid(true, { axis: "y" })

  const seconds = (value) =>
    value
      .split(":")
      .map(Number)
      .reduce((total, part) => total * 60 + part)
  const delta = seconds(last.sunsetLocal) - seconds(first.sunsetLocal)
  const deltaText = `${delta < 0 ? "−" : "+"}${Math.floor(Math.abs(delta) / 60)}m ${String(Math.abs(delta) % 60).padStart(2, "0")}s`
  addEditorialFrame(ax, {
    eyebrow: "SUNSET / NOVEMBER 2026",
    title: "Tokyo",
    stats: [
      { label: "NOV 01", value: `${first.sunsetLocal} JST` },
      { label: "NOV 30", value: `${last.sunsetLocal} JST` },
      { label: "THIS MONTH", value: deltaText },
    ],
    footer: "LOCAL TIME · ASIA/TOKYO (UTC+9)   /   JPL DE440 · SEA LEVEL · STANDARD SEA HORIZON",
  })

  const paths = saveFigure(fig, loaded.mpl, { name: "tokyo-sunset-november-2026", outDir })
  const metadata = {
    data: "derived theoretical ephemeris data",
    sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    generatedAt: data.generatedAt,
    endpoint: data.endpoint,
    ephemVersions: data.versions,
    expectedExampleVersion: EPHEM_VERSION,
    query: data.query,
    first: { date: first.date, sunsetLocal: first.sunsetLocal, sunsetUtc: first.sunsetUtc },
    last: { date: last.date, sunsetLocal: last.sunsetLocal, sunsetUtc: last.sunsetUtc },
    changeSeconds: delta,
    mplRevision: loaded.revision,
    paths,
  }
  await writeFile(join(outDir, "tokyo-sunset-november-2026.metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

const options = argumentsFrom(process.argv.slice(2))
await mkdir(options.outDir, { recursive: true })
let data
let sourceBytes
if (options.derived) {
  sourceBytes = await readFile(options.derived)
  data = JSON.parse(sourceBytes)
  // Keep the supplied derivation beside the rerendered artifacts.
  await writeFile(join(options.outDir, "derived.json"), sourceBytes)
} else {
  data = await fetchData(options.outDir)
  sourceBytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`)
  await writeFile(join(options.outDir, "derived.json"), sourceBytes)
}
const metadata = await render(data, sourceBytes, options.outDir)
console.log(
  JSON.stringify(
    { mode: options.derived ? "offline-rerender" : "fetch-and-render", outDir: options.outDir, ...metadata },
    null,
    2,
  ),
)
