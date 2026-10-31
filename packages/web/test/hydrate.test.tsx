// @vitest-environment happy-dom
// The first frame is the server's, and hydrating it changes nothing: the server renders the page from its answers at its
// instant (src/server/home.tsx); the browser seeds the same state from the same embedded answers and hydrates
// (src/client/home.tsx). Here: answers from core's own request functions (what the API returns), several sky states, a phone
// and a desktop frame; the DOM after hydration must equal the server's HTML, with no node added, removed or replaced.
import { describe, expect, it } from "vitest"
import { hydrate } from "preact"
import { dayRequest, positionRequest, trackRequest } from "@ephem/core"
import { diskBlocks } from "../../core/test/helpers/blocks.ts"
import { renderHomeStatic, bootOf, answersOf, type Embeds } from "../src/server/index.ts"
import { trackQuery, localDate, nextDate } from "../src/lib/time.ts"
import { seedFrame } from "../src/client/home/frame.ts"
import { resetState } from "../src/client/home/state.ts"
import { Header, Home } from "../src/components/home/Home.tsx"
import type { Visitor } from "../src/lib/types.ts"

const memo = new Map<number, ArrayBuffer>()
const src = (i: number) => { let b = memo.get(i); if (!b) { b = diskBlocks(i); memo.set(i, b) } return b }
const NYC: Visitor = { lat: 40.7127, lon: -74.0059, place: "New York City", city: "New York City", tz: "America/New_York", colo: null, source: "query" }

const embedsAt = (v: Visitor, t: number): Embeds => {
  const tq = trackQuery(v.lat, v.lon, t), today = localDate(t, v.tz)
  const day = (date: string) => { const r = dayRequest(src, { date, tz: v.tz, lat: v.lat, lon: v.lon }); return "ok" in r ? r.ok : null }
  return [
    ["ephem-position", JSON.stringify(positionRequest(src, { utcMs: t, lat: v.lat, lon: v.lon }))],
    ["ephem-track", JSON.stringify(trackRequest(src, { lat: v.lat, lon: v.lon, startMs: Date.parse(tq.start), endMs: Date.parse(tq.end), stepSeconds: 1200 }))],
    ["ephem-day", JSON.stringify(day(today))],
    ["ephem-tomorrow", JSON.stringify(day(nextDate(today)))],
    ["ephem-magnetic", JSON.stringify({ magnetic: { declination: -12.86 } })],   // the readouts' compass bearing
  ]
}

describe("hydrating the server's first frame changes nothing", () => {
  const cases: Array<[string, Visitor, string, boolean]> = [
    ["NYC night, phone", NYC, "2026-10-31T00:13:00Z", true], ["NYC day, desktop", NYC, "2026-10-30T14:00:00Z", false],
    ["NYC dusk, phone", NYC, "2026-10-30T22:15:00Z", true],
    ["Tromsø polar night, phone", { ...NYC, lat: 69.6492, lon: 18.9553, tz: "Europe/Oslo", city: "Tromsø", place: "Tromsø" }, "2026-12-15T10:45:00Z", true],
    ["Sydney, desktop", { ...NYC, lat: -33.8688, lon: 151.2093, tz: "Australia/Sydney", city: "Sydney", place: "Sydney" }, "2026-10-30T02:00:00Z", false],
  ]
  for (const [name, v, iso, mobile] of cases) it(name, async () => {
    const t = Date.parse(iso), embeds = embedsAt(v, t)
    const head = { v, blocks: "/assets/de440/0000000000000000/", now: t, at: t, origin: "https://ephem.example", mobile }
    const html = renderHomeStatic(head, embeds)
    // the server's frame shows the data with no script: the chart's discs and labels, the readouts, the countdown, the timeline
    expect(html).toMatch(/<svg class="chart" id="cv"[^>]*>[\s\S]*<rect[^>]*fill="url\(#ephem-sky\)"/)
    expect(html).toMatch(/>SUN<\/text>/); expect(html).toMatch(/>MOON<\/text>/)
    expect(html).toMatch(/elementtiming="ephem-data">−?\d+\.\d\d°</)
    expect(html).toMatch(/id="tminus">T−\d\d:\d\d:\d\d</)
    expect(html).toMatch(/Compass <\/b>|Compass <b>\d+°<\/b>/)
    expect(html).toMatch(/<svg id="tl"[^>]*viewBox="0 0 \d+ \d+"/)
    document.documentElement.innerHTML = html.replace(/^<!doctype html><html[^>]*>/, "").replace(/<\/html>$/, "")
    const hdr = document.getElementById("hdr")!, app = document.getElementById("app")!
    const before = [hdr.innerHTML, app.innerHTML]
    const nodes: MutationRecord[] = []
    const mo = new MutationObserver(rs => nodes.push(...rs.filter(r => r.type === "childList" || r.type === "characterData")))
    mo.observe(hdr, { childList: true, subtree: true, characterData: true }); mo.observe(app, { childList: true, subtree: true, characterData: true })
    seedFrame(bootOf(head), answersOf(embeds))
    hydrate(<Header />, hdr); hydrate(<Home />, app)
    await new Promise(r => setTimeout(r, 20))
    nodes.push(...mo.takeRecords().filter(r => r.type === "childList" || r.type === "characterData")); mo.disconnect()
    const where = (n: Node) => { const e = (n.nodeType === 1 ? n : n.parentNode) as Element | null; return e ? e.nodeName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.getAttribute("class") ? "." + e.getAttribute("class") : "") + (n.nodeType === 3 ? " text " + JSON.stringify((n as Text).data) : "") : "?" }
    expect(hdr.innerHTML).toBe(before[0]); expect(app.innerHTML).toBe(before[1])
    expect(nodes.map(r => r.type + " " + where(r.target) + (r.addedNodes.length ? " +" + [...r.addedNodes].map(n => n.nodeName + (n.nodeType === 3 ? JSON.stringify((n as Text).data) : "")).join(",") : "") + (r.removedNodes.length ? " -" + r.removedNodes.length : ""))).toEqual([])
    resetState()
  }, 60_000)
})
