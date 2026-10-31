// Screenshots of / in every sky state, deterministically: the page's debug ?at=<ISO> (frozen clock, timed /v1/position; the
// server's embed is ignored then) at fixed places, in light and dark, at 390×844, 375×667 and 1440×900. Prints, per shot, the
// chart's label layout from window.__sky: overlaps (must be none), dropped labels, labels that cross a track, and draw count.
//   [SIZES=390,375] node --experimental-strip-types scripts/obs/home-states.ts <base> <outDir> [filter]
// The states (UI acceptance, AGENTS.md): day with the Moon up / down, civil, nautical, astronomical twilight, night with the Moon
// down (Ivar's iPhone, NYC 20:13 2026-10-30) / up, the Sun on the horizon, Tromsø polar night / day, Sydney, Singapore's
// near-zenith Sun, and pointing mode (?pose=az,alt).
import { mkdirSync } from "node:fs"
import { launch } from "./cdp/cdp.ts"
import { emulate, navigate, waitForFn, screenshot, evaluate } from "./cdp/page.ts"

const NYC = ["New York City", 40.7128, -74.006, "America/New_York"] as const
export const STATES: Array<[string, string, number, number, string, string]> = [
  ["01-nyc-day-moon-up", ...NYC, "2026-10-30T14:00:00Z"], ["02-nyc-day-moon-down", ...NYC, "2026-10-30T19:00:00Z"],
  ["03-nyc-civil-twilight", ...NYC, "2026-10-30T22:15:00Z"], ["04-nyc-nautical-twilight", ...NYC, "2026-10-30T22:45:00Z"],
  ["05-nyc-astro-twilight", ...NYC, "2026-10-30T23:15:00Z"], ["06-nyc-night-moon-down", ...NYC, "2026-10-31T00:13:00Z"],
  ["07-nyc-night-moon-up", ...NYC, "2026-10-31T04:00:00Z"], ["08-nyc-sunrise", ...NYC, "2026-10-30T11:35:00Z"],
  ["09-tromso-polar-night", "Tromsø", 69.6492, 18.9553, "Europe/Oslo", "2026-12-15T10:45:00Z"],
  ["10-tromso-polar-day", "Tromsø", 69.6492, 18.9553, "Europe/Oslo", "2026-06-21T22:30:00Z"],
  ["11-sydney", "Sydney", -33.8688, 151.2093, "Australia/Sydney", "2026-10-30T02:00:00Z"],
  ["12-singapore-zenith", "Singapore", 1.3521, 103.8198, "Asia/Singapore", "2026-09-23T04:55:00Z"],
  ["13-nyc-point-phone", ...NYC, "2026-10-31T00:13:00Z&pose=80,15"],
]
const [base, out, filter] = process.argv.slice(2)
if (!base || !out) { console.error("usage: home-states.ts <base> <outDir> [filter]"); process.exit(2) }
mkdirSync(out, { recursive: true })
const b = await launch()
try {
  for (const [w, h] of ([[390, 844], [375, 667], [1440, 900]] as const).filter(([w]) => !process.env.SIZES || process.env.SIZES.split(",").includes(String(w)))) for (const scheme of ["light", "dark"]) for (const [id, place, lat, lon, tz, at] of STATES) {
    if (filter && !id.includes(filter)) continue
    const [time, extra] = at.split("&")
    const url = `${base}/?lat=${lat}&lon=${lon}&tz=${encodeURIComponent(tz)}&place=${encodeURIComponent(place)}&at=${encodeURIComponent(time!)}${extra ? "&" + extra : ""}`
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await b.newPage()
      try {
        await p.send("Page.enable")
        await emulate(p, { name: "x", width: w, height: h, dpr: w > 1000 ? 1 : 2, mobile: w < 1000, touch: w < 1000 })
        await p.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] })
        await p.send("Network.setExtraHTTPHeaders", { headers: { "x-ephem-smoke": "1" } })
        await navigate(p, url)
        await waitForFn(p, `window.__sky && window.__sky.labels && performance.getEntriesByName("ephem:track").length && document.getElementById("next").textContent.trim().length > 2 && document.getElementById("liveT").textContent === "Fixed time"`, 30_000)
        await new Promise(r => setTimeout(r, 600))
        const file = `${out}/${id}-${w}x${h}-${scheme}.png`
        await screenshot(p, file)
        console.log(file.split("/").pop(), await evaluate(p, `JSON.stringify({ overlaps: __sky.overlaps, dropped: __sky.labels.filter(l => l.dropped).map(l => l.id), crossed: __sky.labels.filter(l => l.crossed).map(l => l.id), draws: __sky.draws })`))
        break
      } catch (e) { console.log("retry", id, w, scheme, String(e).slice(0, 120)) } finally { await p.send("Target.closeTarget" as never, { targetId: p.targetId } as never).catch(() => {}) }
    }
  }
} finally { await b.close() }
