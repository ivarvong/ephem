// The design system's colours for canvas and SVG drawing (mission control: white on near-black, one accent for LIVE and NOW,
// amber Sun, silver Moon). The same values are the Tailwind @theme tokens in src/styles/app.css; test/tokens.test.ts checks
// the two agree.
export const COLOR = {
  bg: "#060708",
  ink: "#f2f4f7",
  muted: "#8d939c",
  faint: "#555b64",
  accent: "#6fd8f2",
  sun: "#f5b860",
  moon: "#c9d1de",
  caution: "#e8a64a",
  alert: "#ef6a5e",
} as const

/** The DIN stack for canvas text (CSS uses --font-din). */
export const DIN = "'Ephem DIN', 'DIN Alternate', Bahnschrift, -apple-system, system-ui, sans-serif"

/** Sky colour by the Sun's altitude: [altitude, zenith, horizon]. */
const KEYS: ReadonlyArray<readonly [number, string, string]> = [
  [-90, "#04060d", "#080b18"],
  [-18, "#04060d", "#0b0f22"],
  [-13, "#0a1029", "#1f2450"],
  [-8, "#121a3c", "#4d3f78"],
  [-4, "#1d2a55", "#a85a7c"],
  [0, "#2b4479", "#ee8148"],
  [4, "#31599c", "#e9ac68"],
  [15, "#2a64b0", "#8ab5df"],
  [90, "#1d5bb5", "#73a8e0"],
]
const hex = (c: string) =>
  [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)] as const
const mix = (a: string, b: string, t: number) => {
  const x = hex(a),
    y = hex(b)
  return "rgb(" + [0, 1, 2].map((i) => Math.round(x[i]! + (y[i]! - x[i]!) * t)).join(",") + ")"
}
/** [zenith, horizon] colours of the sky for the Sun at altitude alt. */
export const skyAt = (alt: number): [string, string] => {
  for (let i = 0; i < KEYS.length - 1; i++) {
    const a = KEYS[i]!,
      b = KEYS[i + 1]!
    if (alt <= b[0]) {
      const t = Math.max(0, (alt - a[0]) / (b[0] - a[0]))
      return [mix(a[1], b[1], t), mix(a[2], b[2], t)]
    }
  }
  const last = KEYS[KEYS.length - 1]!
  return [last[1], last[2]]
}
