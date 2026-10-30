// The /instrument calculator's logic: the exact ENGINE_JS string the page ships, run here with new Function.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { ENGINE_JS } from "../src/instrument-engine.ts"
import { ROWS5, ROWS6 } from "../src/instrument.ts"

interface View { lines: string[]; entryLine: number; cursorCol: number; status: [string, string][]; menu: { label: string; dir: boolean }[]; shift: string | null; err: boolean; menuName: string; body: string; mode: string }
interface Calc { press(id: string): void; view(): View; state(): { stack: string[]; entry: string | null; err: string | null; menu: string; body: string; mode: string; raw: { v: number }[] }; seed(items: unknown[]): void }
const R = new Function(ENGINE_JS + "; return RPNEngine")() as {
  create(env?: { sky?: () => unknown }): Calc; fmtNum(v: number, mode: string): string; smallWidth(s: string): number
  toHMS(x: number): number; fromHMS(x: number): number; wrap360(x: number): number; SHIFTED: Record<"L" | "R", Record<string, string>>
}

const SKY = {
  SUN: { AZ: 254.389339579497, ALT: -3.3878389694974738, DECL: -14.01423574229157, DIST: 148544785.9675629 },
  MOON: { AZ: 13.38102979081549, ALT: -22.533543191754955, DECL: 25.540497958125517, DIST: 369469.27767096384, PHASE: "WANING GIBBOUS", ILLUM: 71.51048498675925 },
  DAY: { SUN: { rise: 7.3925, set: 17.9114, transit: 12.6519 }, MOON: { rise: 19.5, transit: 3.25 } },
  HOURS: 18.1458, TIME: "18:08", WHERE: "{ 40.71 -74.01 }", MAGDEC: -12.461292467665574,
}
const calc = (sky: unknown = SKY) => R.create({ sky: () => sky })
const keys = (c: Calc, ...ids: string[]) => { for (const id of ids) { if (/^[0-9.]+$/.test(id)) for (const ch of id) c.press(ch); else c.press(id) } return c }
const top = (c: Calc) => c.view().lines[4]!
const status = (c: Calc) => c.view().status.map(s => s[0])

const fix = (v: number) => R.fmtNum(v, "FIX"), std = (v: number) => R.fmtNum(v, "STD")

describe("formatting (FIX 2 default, STD on FIX)", () => {
  it("two decimals, no leading zero, SCI when the value would vanish or overflow 12 digits", () => {
    expect([fix(254.389339), fix(-3.3878), fix(0.25), fix(-0.5), fix(0), fix(-0.001), fix(0.004999), fix(0.005), fix(148544785.9675629), fix(1e12), fix(-2.5e-7)])
      .toEqual(["254.39", "-3.39", ".25", "-.50", "0.00", "-1.00E-3", "5.00E-3", ".01", "148544785.97", "1.00E12", "-2.50E-7"])
    expect([fix(Infinity), fix(-Infinity), fix(NaN)]).toEqual(["MAXR", "-MAXR", "NaN"])
  })
  it("STD: 12 significant digits, no trailing zeros", () => {
    expect([std(254.389339579497), std(0.0015), std(149597870.7), std(1.495978707e14), std(2), std(-0)]).toEqual(["254.389339579", ".0015", "149597870.7", "1.495978707E14", "2", "0"])
  })
  it("azimuth wraps like the homepage: 359.995 and up reads 0.00", () => {
    expect([R.wrap360(359.996), R.wrap360(-10), R.wrap360(370.25)]).toEqual([0, 350, 10.25])
  })
  it("H.MMSS conversions round-trip", () => {
    expect(R.toHMS(17.9114)).toBeCloseTo(17.5441, 4)
    expect(R.fromHMS(17.5441)).toBeCloseTo(17.9114, 4)
    expect(R.toHMS(-1.5)).toBeCloseTo(-1.3, 10)
    for (const h of [0, 0.01, 7.3925, 12.999999, 23.9999]) expect(R.fromHMS(R.toHMS(h))).toBeCloseTo(h, 6)
  })
})

describe("live readouts: every one 2 dp with its unit, azimuth true and magnetic labelled", () => {
  it("SKY: AZ T, AZ M (true minus WMM declination), ALT, DECL, DIST", () => {
    const c = calc()
    for (let i = 0; i < 5; i++) c.press("SOFT" + i)
    expect(c.view().lines).toEqual([
      "5:     AZ T: 254.39_°",
      "4:     AZ M: 266.85_°",
      "3:       ALT: -3.39_°",
      "2:     DECL: -14.01_°",
      "1:    148544785.97_km",
    ])
    expect(c.view().menu.map(m => m.label)).toEqual(["AZ T", "AZ M", "ALT", "DECL", "DIST", "MOON"])
    c.press("SOFT5"); c.press("SOFT4")   // → MOON, DIST
    expect(top(c)).toBe("1:       369469.28_km")
    expect(c.view().status[1]).toEqual(["{ 40.71 -74.01 }", "MOON"])
  })
  it("DAY: SET RISE − is the day's length in hours; →HMS reads it as h.mmss", () => {
    const c = calc(); c.press("DAY"); c.press("SOFT1"); c.press("SOFT0"); c.press("-")
    expect(top(c)).toBe("1:            10.52_h")
    c.press("SHR"); c.press("4")
    expect(R.fmtNum(c.state().raw[0]!.v, "STD")).toBe("10.310804")
    expect(top(c)).toBe("1:              10.31")
  })
  it("a value the API has not sent yet is an error, never a 0", () => {
    const c = calc({ SUN: {}, MOON: {}, DAY: null })
    c.press("SOFT0")
    expect(status(c)).toEqual(["AZ T ERROR:", "NO DATA"]); expect(c.state().stack).toEqual([])
    c.press("DAY"); c.press("SOFT0")
    expect(status(c)).toEqual(["RISE ERROR:", "NO DATA"])
    const d = calc(); d.press("DAY"); d.press("MOON"); d.press("SOFT1")   // no moonset today
    expect(status(d)).toEqual(["SET ERROR:", "NO MOON SET TODAY"])
  })
  it("the status lines: mode, clock, observer, body; shift annunciators", () => {
    const c = calc()
    expect(c.view().status).toEqual([["DEG FIX 2", "18:08"], ["{ 40.71 -74.01 }", "SUN"]])
    c.press("SHL"); expect(c.view().status[0]).toEqual(["DEG FIX 2", "↰ 18:08"])
    c.press("SHL"); c.press("SHR"); expect(c.view().status[0]).toEqual(["DEG FIX 2", "↱ 18:08"])
    c.press("ON"); c.press("FIX"); expect(c.view().status[0]).toEqual(["DEG STD", "18:08"])
  })
})

describe("RPN stack edge cases", () => {
  it("ENTER commits; ENTER on an empty command line is DUP; a number typed after ENTER pushes (RPL: no stack-lift disable)", () => {
    const c = calc(); keys(c, "12", "ENTER")
    expect(c.state().stack).toEqual(["12"])
    c.press("ENTER"); expect(c.state().stack).toEqual(["12", "12"])
    keys(c, "3"); expect(c.state().entry).toBe("3"); expect(c.view().lines[4]).toBe("3                    "); expect(c.view().cursorCol).toBe(1)
    c.press("+"); expect(c.state().stack).toEqual(["15", "12"])
    c.press("*"); expect(c.state().stack).toEqual(["180"])
  })
  it("DROP on an empty stack: 'DROP Error: Too Few Arguments' on the status lines; the next key clears it", () => {
    const c = calc(); c.press("BACK")
    expect(status(c)).toEqual(["DROP ERROR:", "TOO FEW ARGUMENTS"]); expect(c.state().err).toBe("DROP Error: Too Few Arguments")
    c.press("5"); expect(c.view().err).toBe(false); expect(status(c)[0]).toBe("DEG FIX 2")
    const d = calc(); d.press("SHR"); d.press("BACK"); expect(d.state().err).toBe("DROP Error: Too Few Arguments")
    const e = calc(); e.press("ENTER"); expect(e.state().err).toBe("DUP Error: Too Few Arguments")
  })
  it("a failed command leaves its arguments; the typed number it parsed stays pushed", () => {
    const c = calc(); keys(c, "5", "+")
    expect(c.state().err).toBe("+ Error: Too Few Arguments"); expect(c.state().stack).toEqual(["5"])
    c.press("SOFT0"); c.press("+")   // AZ T (°) + 5 (no unit)
    expect(c.state().err).toBe("+ Error: Inconsistent Units"); expect(c.state().stack.length).toBe(2)
    keys(c, "0"); c.press("/"); expect(c.state().err).toBe("/ Error: Infinite Result")
    const d = calc(); keys(d, "0", "ENTER", "0"); d.press("/"); expect(d.state().err).toBe("/ Error: Undefined Result")
    const s = calc(); s.press("DAY"); s.press("SOFT4"); s.press("SIN"); expect(s.state().err).toBe("SIN Error: Bad Argument Type")
  })
  it("units: trig takes degrees, ASIN returns them, SQ/√ and km·km round-trip", () => {
    const c = calc(); keys(c, "30"); c.press("SIN"); expect(c.state().stack[0]).toBe(".5")
    c.press("SHL"); c.press("SIN"); expect(c.state().stack[0]).toBe("30_°")
    c.press("CONST"); c.press("SOFT2"); c.press("SHL"); c.press("SQRT"); c.press("SQRT"); expect(c.state().stack[0]).toBe("6378.137_km")
    c.press("SOFT2"); c.press("SOFT2"); c.press("/"); expect(c.state().stack[0]).toBe("1")
    keys(c, "90"); c.press("TAN"); expect(c.state().err).toBe("TAN Error: Infinite Result")
  })
  it("command line: one point and one E per number, +/- on the mantissa or the exponent, SPC separates numbers", () => {
    const c = calc(); keys(c, "1..5"); expect(c.state().entry).toBe("1.5")
    c.press("EEX"); c.press("EEX"); keys(c, "3"); c.press("NEG"); expect(c.state().entry).toBe("1.5E-3")
    c.press("ENTER"); expect(c.state().stack).toEqual([".0015"])
    keys(c, "1"); c.press("SPC"); keys(c, "2"); c.press("SPC"); keys(c, "3"); c.press("NEG"); c.press("ENTER")
    expect(c.state().stack).toEqual(["-3", "2", "1", ".0015"])
    c.press("EEX"); expect(c.state().entry).toBe("1E")
    c.press("BACK"); c.press("BACK"); expect(c.state().entry).toBeNull()
    keys(c, "."); c.press("ENTER"); expect(c.state().err).toBe("Error: Invalid Syntax"); expect(c.state().entry).toBe(".")   // kept, as the hardware does
    c.press("DEL"); expect(c.state().entry).toBeNull()
  })
  it("SWAP DUP OVER ROT DEPTH CLEAR, LASTARG and UNDO", () => {
    const c = calc(); keys(c, "1", "ENTER", "2", "ENTER", "3")
    c.press("ROT"); expect(c.state().stack).toEqual(["1", "3", "2"])
    c.press("SWAP"); c.press("OVER"); expect(c.state().stack).toEqual(["1", "3", "1", "2"])
    c.press("DEPTH"); expect(c.state().stack[0]).toBe("4")
    c.press("+"); expect(c.state().stack[0]).toBe("5")
    c.press("LAST"); expect(c.state().stack.slice(0, 3)).toEqual(["4", "1", "5"])
    c.press("UNDO"); expect(c.state().stack).toEqual(["5", "3", "1", "2"])
    c.press("UNDO"); expect(c.state().stack).toEqual(["4", "1", "5", "3", "1", "2"])   // UNDO again redoes
    c.press("SHL"); c.press("DEL"); expect(c.state().stack).toEqual([])
    c.press("UNDO"); expect(c.state().stack.length).toBe(6)
    const d = calc(); d.press("LAST"); expect(d.state().err).toBe("LASTARG Error: No Arguments Saved")
  })
  it("menus: NXT and PREV cycle SKY DAY CONST MAIN; soft keys with folders; blanks do nothing; ON cancels", () => {
    const c = calc(); const m = () => c.view().menuName
    c.press("NXT"); expect(m()).toBe("DAY"); c.press("NXT"); c.press("NXT"); expect(m()).toBe("MAIN")
    expect(c.view().menu).toEqual([{ label: "SKY", dir: true }, { label: "DAY", dir: true }, { label: "CONST", dir: true }, { label: "", dir: false }, { label: "", dir: false }, { label: "", dir: false }])
    c.press("SOFT4"); expect(c.state().stack).toEqual([]); expect(c.view().err).toBe(false)
    c.press("NXT"); expect(m()).toBe("SKY"); c.press("SHL"); c.press("NXT"); expect(m()).toBe("MAIN")
    c.press("SOFT2"); expect(m()).toBe("CONST")
    keys(c, "42"); c.press("ON"); expect(c.state().entry).toBeNull()
    c.press("SHR"); c.press("8"); expect(c.view().body).toBe("MOON")
  })
  it("display: five levels, command line at the bottom with level 5 hidden, long entries keep their tail", () => {
    const c = calc(); for (let i = 1; i <= 6; i++) keys(c, String(i), "ENTER")
    expect(c.view().lines[0]).toBe("5:               2.00")
    keys(c, "1234567890123456789012345")
    const v = c.view(); expect(v.entryLine).toBe(4); expect(v.lines[0]).toBe("4:               3.00"); expect(v.lines[4]).toBe("…" + "4567890123456789012345".slice(-19) + " ")
  })
  it("seeding only touches an untouched calculator", () => {
    const c = calc(); keys(c, "7"); c.seed([{ k: "n", v: 1, u: "" }]); c.press("ENTER"); expect(c.state().stack).toEqual(["7"])
  })
})

describe("the keyboard's legends are the engine's shifted functions", () => {
  const legendToFn: Record<string, string> = { PREV: "PREV", ASIN: "ASIN", ACOS: "ACOS", ATAN: "ATAN", "x^2": "SQ", "10^x": "10^x", LOG: "LOG", "e^x": "e^x", LN: "LN", ABS: "ABS", "π": "PI", CLEAR: "CLEAR", DROP: "DROP", SUN: "SUN", MOON: "MOON", "→HMS": "TOHMS", "HMS→": "FROMHMS" }
  it("every legend has its function and every function its legend", () => {
    const fromKeys = { L: {} as Record<string, string>, R: {} as Record<string, string> }
    for (const k of [...ROWS6.flat(), ...ROWS5.flat()]) {
      if (k.l) fromKeys.L[k.id] = legendToFn[k.l]!
      if (k.r) fromKeys.R[k.id] = legendToFn[k.r]!
    }
    expect(fromKeys).toEqual(R.SHIFTED)
    expect(ROWS6.map(r => r.reduce((n, k) => n + (k.wide ? 2 : 1), 0))).toEqual([6, 6, 6, 6])
    expect(ROWS5.map(r => r.length)).toEqual([5, 5, 5, 5])
  })
})

describe("RPN Dot Small widths match the font builder", () => {
  it("SMALL_W (status line and menu layout) = the glyph widths in scripts/instrument-fonts/rpn_dot_small.py", () => {
    const src = readFileSync(new URL("../../../scripts/instrument-fonts/rpn_dot_small.py", import.meta.url), "utf8")
    const glyphs = [...src.matchAll(/g\('((?:\\'|[^'])+|')',\s*'([.#]+)'/g)]
    expect(glyphs.length).toBeGreaterThan(65)
    for (const [, ch, row] of glyphs) {
      const c = ch === "\\'" ? "'" : ch!
      expect(R.smallWidth(c), c).toBe(row!.length)
    }
    // every label the menus can show fits a 21-dot cell
    for (const l of ["AZ T", "AZ M", "ALT", "DECL", "DIST", "MOON", "SUN", "RISE", "SET", "TRANS", "NOW", "PHASE", "ILLUM", "AU", "C", "RE", "G", "π", "MAIN", "SKY", "DAY", "CONST"]) expect(R.smallWidth(l), l).toBeLessThanOrEqual(21)
  })
})
