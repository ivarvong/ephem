import { describe, it } from "vitest"
import { execFileSync } from "node:child_process"
import { localDay, localMidnight } from "../src/day.ts"
import { expect } from "vitest"
describe("local midnight", () => it("matches Python zoneinfo across DST-at-midnight zones, 1972–2149", () => {
  // Zones that shift at or near midnight. Africa/Casablanca is left out: ICU (2025b) and the system tzdata disagree on
  // Morocco's Ramadan rule after 2027, which is a data-version difference, not a conversion bug.
  const zones = ["America/New_York", "America/Santiago", "America/Havana", "Atlantic/Azores", "Asia/Beirut", "America/Sao_Paulo", "Pacific/Apia", "Australia/Lord_Howe", "Europe/Oslo", "Asia/Tehran", "America/Asuncion"]
  const dates: string[] = []
  for (let y = 1972; y <= 2149; y += 7) for (const md of ["01-01", "03-08", "03-09", "03-10", "03-29", "04-05", "09-06", "09-07", "10-25", "10-26", "11-01", "11-02", "12-31"]) dates.push(`${y}-${md}`)
  const py = `
import sys, json, datetime as dt
from zoneinfo import ZoneInfo
out = {}
for z in json.load(sys.stdin)["zones"]:
    Z = ZoneInfo(z)
    for d in json.load(open("/dev/fd/3"))["dates"] if False else ${JSON.stringify(dates)}:
        y, m, dd = map(int, d.split("-"))
        t = dt.datetime(y, m, dd, tzinfo=Z)
        # Python maps a nonexistent midnight with the pre-transition offset; normalise to the first existing instant of that date
        u = t.timestamp()
        while dt.datetime.fromtimestamp(u, Z).date() < dt.date(y, m, dd): u += 60
        out[z + " " + d] = u * 1000
print(json.dumps(out))`
  const ref = JSON.parse(execFileSync("python3", ["-c", py], { input: JSON.stringify({ zones }) }).toString()) as Record<string, number>
  let bad = 0
  for (const z of zones) for (const d of dates) { const ours = localMidnight(d, z), theirs = ref[`${z} ${d}`]!; if (ours !== theirs) { bad++; if (bad < 8) process.stderr.write(`${z} ${d}: ours ${new Date(ours).toISOString()} zoneinfo ${new Date(theirs).toISOString()}\n`) } }
  process.stderr.write(`${zones.length * dates.length} cases, ${bad} mismatches\n`)
  if (bad) throw new Error("mismatch")
}))

describe("localDay", () => it("refuses dates off the calendar and days a zone skipped; leap days, DST days and non-hour offsets are real days", () => {
  for (const d of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2100-02-29"]) expect(localDay(d, "UTC"), d).toHaveProperty("error")
  expect(localDay("2011-12-30", "Pacific/Apia")).toMatchObject({ error: expect.stringMatching(/does not exist in Pacific\/Apia/) })
  expect(localDay("1993-08-21", "Pacific/Kwajalein")).toHaveProperty("error")   // Kwajalein crossed the date line: 20 Aug → 22 Aug
  const len = (d: string, tz: string) => { const r = localDay(d, tz); if (!("ok" in r)) throw new Error(r.error); return (r.ok.endMs - r.ok.startMs) / 3_600_000 }
  expect(len("2028-02-29", "UTC")).toBe(24); expect(len("2000-02-29", "UTC")).toBe(24)
  expect(len("2026-03-08", "America/New_York")).toBe(23); expect(len("2026-11-01", "America/New_York")).toBe(25)
  expect(len("2026-10-04", "Australia/Lord_Howe")).toBe(23.5); expect(len("2026-04-05", "Australia/Lord_Howe")).toBe(24.5)   // 30-minute DST
  expect(len("2026-10-31", "Asia/Kathmandu")).toBe(24)
  expect(localDay("2026-10-31", "Asia/Kathmandu")).toEqual({ ok: { startMs: Date.parse("2026-10-30T18:15:00Z"), endMs: Date.parse("2026-10-31T18:15:00Z") } })   // UTC+5:45
  expect(len("2011-12-29", "Pacific/Apia")).toBe(24)
}))
