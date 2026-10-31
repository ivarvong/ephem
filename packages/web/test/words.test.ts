import { describe, expect, it } from "vitest"
import {
  ago,
  altOf,
  condition,
  countdown,
  hhmmss,
  lede,
  offText,
  skyPhase,
  windText,
  wxWord,
} from "../src/lib/words.ts"
import type { Body, Moon } from "../src/lib/types.ts"

const body = (apparentAltitude: number | null, azimuth: number, altitude = apparentAltitude ?? 0): Body => ({
  apparentAltitude,
  azimuth,
  altitude,
  declination: 0,
  distanceKm: 1,
})
const moon = (alt: number | null, az: number, altitude = alt ?? 0): Moon => ({
  ...body(alt, az, altitude),
  phase: { name: "waning gibbous", illuminatedFraction: 0.85, brightLimbAngle: 0 },
})

describe("words", () => {
  it("apparentAltitude null below the horizon: the true altitude stands in (API 2026-10-29)", () => {
    expect(altOf({ apparentAltitude: null, altitude: -20.31 })).toBe(-20.31)
    expect(altOf({ apparentAltitude: 2.31, altitude: 2.0 })).toBe(2.31)
    expect(lede(body(30, 180, 29.97), moon(null, 300, -12))).toBe("The Sun is in the south and the Moon is down.")
  })
  it("countdowns carry seconds only under a minute; the hero is always HH:MM:SS", () => {
    expect(countdown(35e3)).toBe("in 35 s")
    expect(countdown(14 * 60e3)).toBe("in 14 min")
    expect(countdown((3 * 3600 + 59 * 60 + 25) * 1e3)).toBe("in 3 h 59 min")
    expect(countdown(2 * 3600e3)).toBe("in 2 h")
    expect(hhmmss((3 * 3600 + 5 * 60 + 9) * 1e3 + 999)).toBe("03:05:09")
    expect(hhmmss(-5)).toBe("00:00:00")
  })
  it("ages and offsets", () => {
    expect(ago(42)).toBe("42 s ago")
    expect(ago(600)).toBe("10 min ago")
    expect(ago(7200)).toBe("2.0 h ago")
    expect(offText(45e3)).toBe("in 45 S")
    expect(offText(-2 * 3600e3)).toBe("2 H ago")
    expect(offText((3 * 60 + 20) * 60e3)).toBe("in 3 H 20 MIN")
  })
  it("one sentence for what's up", () => {
    expect(lede(body(2.83, 110.37), moon(39.58, 274.31))).toBe(
      "The Sun is low in the east-southeast, and the waning gibbous Moon is in the west.",
    )
    expect(lede(body(-55, 314), moon(34.5, 82))).toBe("It's night, and the waning gibbous Moon is in the east.")
    expect(lede(body(45, 180), moon(-9, 318))).toBe("The Sun is high in the south and the Moon is down.")
    expect(lede(body(-3, 100), moon(-1, 300))).toBe("It's dawn and the Moon is down.")
  })
  it("sky phase from the Sun's altitude", () => {
    expect([1, -3, -9, -15, -30].map(skyPhase)).toEqual([
      "Daylight",
      "Civil twilight",
      "Nautical twilight",
      "Astronomical twilight",
      "Night",
    ])
  })
  it("METAR wind in whole degrees, true and magnetic (reported to the nearest 10°)", () => {
    const w = { directionDegTrue: 260, speedKt: 12, gustKt: null, calm: false, variable: false }
    expect(windText(w, -12.46)).toBe("Wind 260° T · 272° M at 12 kt")
    expect(windText({ ...w, directionDegTrue: 350, gustKt: 25 }, 12.4)).toBe(
      "Wind 350° T · 338° M at 12 kt, gusting 25 kt",
    )
    expect(windText({ ...w, directionDegTrue: 355 }, -6)).toBe("Wind 355° T · 1° M at 12 kt")
    expect(windText({ ...w, calm: true, speedKt: 0 }, 0)).toBe("Wind calm")
    expect(windText({ ...w, variable: true, directionDegTrue: null, speedKt: 3 }, 0)).toBe("Wind variable at 3 kt")
    expect(windText({ ...w, speedKt: null }, 0)).toBe("Wind not reported")
  })
  it("conditions from present weather, else the thickest cloud layer", () => {
    expect(condition({ wx: "-RA BR", sky: [], raw: "" })).toBe("Light rain, mist")
    expect(condition({ wx: "+SHRA", sky: [], raw: "" })).toBe("Heavy rain showers")
    expect(condition({ wx: "VCTS", sky: [], raw: "" })).toBe("Thunderstorm nearby")
    expect(
      condition({
        wx: null,
        sky: [
          { cover: "FEW", baseFtAgl: 1 },
          { cover: "BKN", baseFtAgl: 2 },
        ],
        raw: "",
      }),
    ).toBe("Mostly cloudy")
    expect(condition({ wx: null, sky: [], raw: "METAR KJRB 291056Z AUTO 26004KT 10SM CLR 13/13 A3030" })).toBe("Clear")
    expect(condition({ wx: null, sky: [], raw: "X", verticalVisibilityFt: 200 })).toBe("Sky obscured")
    expect(wxWord("XYZ")).toBe("XYZ")
  })
})
