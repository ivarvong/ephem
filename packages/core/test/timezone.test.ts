import { describe, it } from "vitest"
import { execFileSync } from "node:child_process"
import { localMidnight } from "../src/day.ts"
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
