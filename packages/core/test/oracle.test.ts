// Core vs the frozen Skyfield oracle (reference/oracle/fixtures.py). Tolerances mirror reference/oracle/crosscheck.py.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { crossingRequest, crossingWindow, dayRequest, positionRequest } from "../src/sky.ts"
import { alignmentRequest } from "../src/alignment-request.ts"
import { diskBlocks } from "./helpers/blocks.ts"

const fx = JSON.parse(readFileSync(resolve(__dirname, "fixtures/oracle.json"), "utf8")) as any
const TOL = { angle: 1e-4, raHours: 1e-4 / 15, km: 0.01, radius: 1e-6, fraction: 1e-6, jd: 1e-9, s: 1e-6, eventS: 0.5, alignM: 1.0, alignKm: 1e-3, geoidM: 0.01, rate: 1e-4 }
const ang = (a: number, b: number) => Math.abs(((a - b + 180) % 360 + 360) % 360 - 180)
const num = (q: Record<string, string>, k: string) => (k in q ? Number(q[k]) : undefined)
const horizon = (q: Record<string, string>) => (q.horizon === undefined || q.horizon === "sea" || q.horizon === "geometric" ? q.horizon as "sea" | "geometric" | undefined : Number(q.horizon))
const obs = (q: Record<string, string>) => ({ lat: Number(q.lat), lon: Number(q.lon), height: num(q, "height"), heightRef: q.heightRef as "ellipsoid" | "msl" | undefined })
const nullable = (key: string, a: number | null, b: number | null, tol: number, ctx: string) => {
  expect(a === null, `${key} null in one only [${ctx}]: ${a} vs ${b}`).toBe(b === null)
  if (a !== null && b !== null) check(key, Math.abs(a - b), tol, ctx)
}
const cmpObserver = (a: any, b: any, ctx: string) => {
  for (const k of ["height", "heightEllipsoid", "heightMsl", "geoidUndulation"]) check("observer." + k, Math.abs(a[k] - b[k]), TOL.geoidM, ctx)
  expect(a.heightRef).toBe(b.heightRef)
}
const worst: Record<string, number> = {}
const check = (key: string, d: number, tol: number, ctx: string) => { worst[key] = Math.max(worst[key] ?? 0, d); expect(d, `${key} [${ctx}]`).toBeLessThanOrEqual(tol) }

const cmpBody = (prefix: string, a: any, b: any, ctx: string) => {
  for (const k of ["azimuth", "eclipticLongitude"]) check(prefix + k, ang(a[k], b[k]), TOL.angle, ctx)
  for (const k of ["altitude", "declination", "eclipticLatitude"]) check(prefix + k, Math.abs(a[k] - b[k]), TOL.angle, ctx)
  nullable(prefix + "apparentAltitude", a.apparentAltitude, b.apparentAltitude, TOL.angle, ctx)
  for (const k of ["altitudeRate", "azimuthRate"]) check(prefix + k, Math.abs(a[k] - b[k]), TOL.rate, ctx)
  check(prefix + "rightAscension", Math.abs(((a.rightAscension - b.rightAscension + 12) % 24 + 24) % 24 - 12), TOL.raHours, ctx)
  check(prefix + "distanceKm", Math.abs(a.distanceKm - b.distanceKm), TOL.km, ctx)
  check(prefix + "angularRadius", Math.abs(a.angularRadius - b.angularRadius), TOL.radius, ctx)
}

describe("position", () => {
  it.each(fx.position.map((c: any) => [c.query.time, c]) as [string, any][])("%s", (_t, c: any) => {
    const q = c.query, e = c.expect, ctx = `${q.time} @${q.lat},${q.lon}`
    const r = positionRequest(diskBlocks, { utcMs: Date.parse(q.time), ...obs(q), temperature: num(q, "temperature"), pressure: num(q, "pressure"), horizon: horizon(q), dut1: num(q, "dut1") })
    cmpObserver(r.observer, e.observer, ctx)
    nullable("pos.horizon.dip", r.conventions.horizon.dip, e.conventions.horizon.dip, TOL.angle, ctx)
    check("pos.refraction.validFrom", Math.abs(r.conventions.refraction.validFrom - e.conventions.refraction.validFrom), TOL.angle, ctx)
    check("time.jdTT", Math.abs(r.time.jdTT - e.time.jdTT), TOL.jd, ctx); check("time.jdUT1", Math.abs(r.time.jdUT1 - e.time.jdUT1), TOL.jd, ctx)
    check("time.deltaT", Math.abs(r.time.deltaT - e.time.deltaT), TOL.s, ctx)
    cmpBody("sun.", r.sun, e.sun, ctx); cmpBody("moon.", r.moon, e.moon, ctx)
    const p = r.moon.phase, ep = e.moon.phase
    check("phase.phaseAngle", Math.abs(p.phaseAngle - ep.phaseAngle), TOL.angle, ctx)
    check("phase.illuminatedFraction", Math.abs(p.illuminatedFraction - ep.illuminatedFraction), TOL.fraction, ctx)
    check("phase.elongation", ang(p.elongation, ep.elongation), TOL.angle, ctx); check("phase.brightLimbAngle", ang(p.brightLimbAngle, ep.brightLimbAngle), TOL.angle, ctx)
    expect(p.name).toBe(ep.name)
  })
})

describe("day", () => {
  it.each(fx.day.map((c: any) => [`${c.query.date} ${c.query.tz}`, c]) as [string, any][])("%s", (_t, c: any) => {
    const q = c.query, e = c.expect, ctx = `${q.date} ${q.tz} @${q.lat},${q.lon}`
    const out = dayRequest(diskBlocks, { date: q.date, tz: q.tz, ...obs(q), temperature: num(q, "temperature"), pressure: num(q, "pressure"), horizon: horizon(q),
      horizonProfile: q.horizonProfile, aim: (q.aim ?? q.limb) as "upper" | "center" | "lower" | undefined, dut1: num(q, "dut1") })   // fixtures recorded with the old name `limb`
    if (!("ok" in out)) throw new Error(out.error)
    const r = out.ok
    expect(r.start).toBe(e.start); expect(r.end).toBe(e.end)
    cmpObserver(r.observer, e.observer, ctx)
    const rs = r.conventions.riseSet, es = e.conventions.riseSet
    expect(rs.aim.point).toBe(es.aim?.point ?? es.limb)
    nullable("day.horizon.altitude", rs.horizon.altitude, es.horizon.altitude, TOL.angle, ctx)
    nullable("day.refraction.atHorizon", rs.refraction.atHorizon, es.refraction.atHorizon, TOL.angle, ctx)
    nullable("day.trueLimbAltitude", rs.trueLimbAltitude, es.trueLimbAltitude, TOL.angle, ctx)
    const key = (x: any) => `${x.body}.${x.kind}`
    expect(r.events.map(key)).toEqual(e.events.map(key))
    r.events.forEach((x, i) => check(`event.${key(x)}`, Math.abs(Date.parse(x.time) - Date.parse(e.events[i].time)) / 1000, TOL.eventS, ctx))
  })
})

describe("crossing", () => {
  it.each(fx.crossing.map((c: any) => [Object.entries(c.query).filter(([k]) => k !== "lat" && k !== "lon").map(([k, v]) => `${k}=${v}`).join("&"), c]) as [string, any][])("%s", (_t, c: any) => {
    const q = c.query, e = c.expect, ctx = _t
    const w = crossingWindow(q); if (!("ok" in w)) throw new Error(w.error)
    const out = crossingRequest(diskBlocks, { ...w.ok, ...obs(q), body: q.body, altitude: num(q, "altitude"), altitudeType: q.altitudeType, horizonProfile: q.horizonProfile,
      aim: q.aim ?? q.limb, direction: q.direction, temperature: num(q, "temperature"), pressure: num(q, "pressure"), dut1: num(q, "dut1") })
    if (!("ok" in out)) throw new Error(out.error)
    const r = out.ok
    expect(r.start).toBe(e.start); expect(r.end).toBe(e.end); cmpObserver(r.observer, e.observer, ctx)
    nullable("crossing.trueLimbAltitude", r.conventions.trueLimbAltitude, e.conventions.trueLimbAltitude, 1e-9, ctx)
    expect(r.crossings.map(x => x.direction)).toEqual(e.crossings.map((x: any) => x.direction))
    r.crossings.forEach((x, i) => { const y = e.crossings[i]
      check("crossing.time", Math.abs(Date.parse(x.time) - Date.parse(y.time)) / 1000, TOL.eventS, ctx)
      check("crossing.altitudeRate", Math.abs(x.altitudeRate - y.altitudeRate), TOL.rate, ctx) })
  })
})

describe("alignment", () => {
  it.each(fx.alignment.map((c: any) => [`${c.query.body} ${c.query.start}`, c]) as [string, any][])("%s", (_t, c: any) => {
    const q = c.query, e = c.expect, ctx = `${q.body} ${q.start}`
    const r = alignmentRequest(diskBlocks, { body: q.body, targetLat: +q.targetLat, targetLon: +q.targetLon, targetHeight: +q.targetHeight, targetHeightRef: q.targetHeightRef,
      height: num(q, "height"), heightRef: q.heightRef, startMs: Date.parse(q.start), endMs: Date.parse(q.end), stepSeconds: num(q, "stepSeconds") ?? 60, maxDistanceKm: num(q, "maxDistanceKm") ?? 20,
      temperature: num(q, "temperature"), pressure: num(q, "pressure"), dut1: num(q, "dut1"), ...(q.lat ? { observer: { lat: +q.lat, lon: +q.lon } } : {}) })
    expect(r.track.map(p => p.time)).toEqual(e.track.map((p: any) => p.time))
    r.track.forEach((p, i) => { const o = e.track[i]
      check("align.position_m", Math.hypot((p.lat - o.lat) * 111_132, (p.lon - o.lon) * 111_320 * Math.cos(p.lat * Math.PI / 180)), TOL.alignM, ctx + " " + p.time)
      check("align.distanceKm", Math.abs(p.distanceKm - o.distanceKm), TOL.alignKm, ctx); check("align.azimuth", ang(p.azimuth, o.azimuth), TOL.angle, ctx)
      check("align.apparentAltitude", Math.abs(p.apparentAltitude - o.apparentAltitude), TOL.angle, ctx)
      if ("heightEllipsoid" in o) check("align.heightEllipsoid", Math.abs(p.heightEllipsoid - o.heightEllipsoid), TOL.alignM, ctx) })
    if (e.fromObserver) { expect(r.fromObserver).toBeDefined(); const f = r.fromObserver!, g = e.fromObserver
      check("from.azimuthToTarget", ang(f.azimuthToTarget, g.azimuthToTarget), TOL.angle, ctx); check("from.targetElevation", Math.abs(f.targetElevation - g.targetElevation), TOL.angle, ctx)
      expect(f.passes.length).toBe(g.passes.length)
      f.passes.forEach((p, i) => { check("from.pass.time", Math.abs(Date.parse(p.time) - Date.parse(g.passes[i].time)) / 1000, TOL.eventS, ctx); check("from.pass.altitudeOffset", Math.abs(p.altitudeOffset - g.passes[i].altitudeOffset), TOL.angle, ctx) }) }
  })
})

it("report worst deviations", () => {
  const lines = Object.entries(worst).toSorted().map(([k, v]) => `${k.padEnd(28)} ${v.toExponential(3)}`)
  process.stderr.write("\nworst |Δ| vs oracle:\n" + lines.join("\n") + "\n")
})
