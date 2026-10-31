// Ephem DIN for glyph: glyph fetches fonts by https URL, pinned by sha256. The page's own font files (packages/web/src/fonts,
// content-hashed by the web build and served by Workers Static Assets, immutable) are named here with the sha256 the build
// recorded (packages/web/dist/assets.json); test/og.test.ts checks the hashes against the bytes.
// glyph fetches the font from this version's own preview URL (https://<version id[0:8]>-ephem.ivar.workers.dev), so the spec
// only ever names a path the same version serves: a font change is one deploy, and a canary renders with its own font
// (2026-10-31: 352678e named a path only the canary served, while glyph fetched the live host, and got the fallback card).
import { assets } from "@ephem/web/server"
import { DIN_ADV } from "./din.ts"

export const OG_ORIGIN = "https://ephem.ivar.workers.dev"
/** This version's preview URL (workers.dev preview URLs are on for ephem); the public host when the version is unknown (tests, dev). */
export const versionOrigin = (versionId?: string) =>
  /^[0-9a-f]{8}/.test(versionId ?? "") ? `https://${versionId!.slice(0, 8)}-ephem.ivar.workers.dev` : OG_ORIGIN
/** The Ephem DIN the OG card names (served by the version that renders it), and its characters and advances (src/og.ts lays
 *  out and picks faces with these). */
export const ogFonts = (versionId?: string) => {
  const o = versionOrigin(versionId),
    f = assets().fonts
  return {
    regular: { url: o + f.regular.href, sha256: f.regular.sha256 },
    bold: { url: o + f.bold.href, sha256: f.bold.sha256 },
  } as const
}
export const OG_FONTS = ogFonts()
export const OG_DIN_ADV = DIN_ADV

// The OG card's fallback face: a text item with any character Ephem DIN lacks (Cyrillic, Greek, Vietnamese, Ŋ…) is set whole
// in Noto Sans (OFL), so no letter is dropped or swapped (glyph refuses a missing glyph and has no per-glyph fallback).
// Pinned by commit and sha256; glyph fetches it only for a spec that uses it. NOTO_RANGES: the code points both weights map
// (fontTools getBestCmap of these exact files, 2965 code points). Text neither font covers (CJK…): src/og.ts shows coordinates.
const NOTO =
  "https://raw.githubusercontent.com/notofonts/notofonts.github.io/412a7edb2c8c535d1066157e5b17e661fd5591fe/fonts/NotoSans/unhinted/ttf/NotoSans-"
export const NOTO_FONTS = {
  regular: { url: NOTO + "Regular.ttf", sha256: "f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8" },
  bold: { url: NOTO + "Bold.ttf", sha256: "87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9" },
} as const
const NOTO_RANGES =
  "0,d,20-7e,a0-377,37a-37f,384-38a,38c,38e-3a1,3a3-3e1,3f0-52f,10fb,1ab0-1ac0,1ac5,1ac7-1ace,1c80-1c88,1d00-1df9,1dfb-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fc4,1fc6-1fd3,1fd6-1fdb,1fdd-1fef,1ff2-1ff4,1ff6-1ffe,2000-2064,2066-2071,2074-208e,2090-209c,20a0-20c0,20f0,2100-215f,2183-2184,2189,2212,25cc,2c60-2c7f,2de0-2e5d,a640-a69f,a700-a7ca,a7d0-a7d1,a7d3,a7d5-a7d9,a7f2-a7ff,a92e,ab30-ab6b,fb00-fb06,fe00,fe20-fe2f,feff,fffc-fffd,10780-10785,10787-107b0,107b2-107ba,1df00-1df1e"
const NR = NOTO_RANGES.split(",").map((r) => {
  const [a = "", b = a] = r.split("-")
  return [parseInt(a, 16), parseInt(b, 16)] as const
})
export const notoHas = (c: string) => {
  const cp = c.codePointAt(0)!
  return NR.some(([a, b]) => cp >= a && cp <= b)
}
