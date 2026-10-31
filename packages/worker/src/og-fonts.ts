// Ephem DIN for glyph: glyph fetches fonts by https URL, pinned by sha256, so the front door serves the page's own inline font
// (src/din.ts) at immutable, content-addressed paths: /assets/<sha256[0:16]>/ephem-din-{regular,bold}.woff2.
// test/og.test.ts checks these hashes against the bytes, so regenerating src/din.ts without updating them fails the gate.
// A font change is TWO deploys: glyph fetches from the public host, i.e. the live (100 %) version, never the canary whose spec
// names the font (2026-10-31: 352678e named a path only the canary served; the canary smoke got the fallback card and removed
// it). Deploy 1 serves the new font beside the previous one (keep the old base64 + advances in a din-prev.ts, return both
// from servedFont, OG_FONTS/OG_DIN_ADV on the previous font); deploy 2 points the card at the new font and drops the old
// (done that way in 90d178e → this commit).
import { DIN_ADV, DIN_BOLD_B64, DIN_REGULAR_B64 } from "./din.ts"

type W = "regular" | "bold"
export const OG_ORIGIN = "https://ephem.ivar.workers.dev"   // glyph fetches from the public host: the live version must serve the font
export const DIN_SHA256 = {
  regular: "316a72622a0926ee85e3db60007e0347aede4005a56d197a624d8910a3292d50",
  bold: "13667defdc54a0cd8716d8afc8214a513971739e55af58093265439886a2cf71",
} as const
const path = (sha: string, w: W) => `/assets/${sha.slice(0, 16)}/ephem-din-${w}.woff2`
export const fontPath = (w: W) => path(DIN_SHA256[w], w)
const B64 = { regular: DIN_REGULAR_B64, bold: DIN_BOLD_B64 } as const
type K = keyof typeof B64
let bytes: Partial<Record<K, Uint8Array<ArrayBuffer>>> = {}
const dec = (k: K): Uint8Array<ArrayBuffer> => (bytes[k] ??= Uint8Array.from(atob(B64[k]), c => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>)
export const fontBytes = (w: W) => dec(w)
export const resetFontBytes = () => { bytes = {} }
/** The bytes the front door serves at an /assets path (during a font change, also the previous font's: see the header). */
export const servedFont = (p: string): Uint8Array<ArrayBuffer> | null => {
  for (const w of ["regular", "bold"] as const) if (p === fontPath(w)) return fontBytes(w)
  return null
}
/** The Ephem DIN the OG card names, and its characters and advances (src/og.ts lays out and picks faces with these). */
export const OG_FONTS = {
  regular: { url: OG_ORIGIN + fontPath("regular"), sha256: DIN_SHA256.regular },
  bold: { url: OG_ORIGIN + fontPath("bold"), sha256: DIN_SHA256.bold },
} as const
export const OG_DIN_ADV = DIN_ADV

// The OG card's fallback face: a text item with any character Ephem DIN lacks (Cyrillic, Greek, Vietnamese, Ŋ…) is set whole
// in Noto Sans (OFL), so no letter is dropped or swapped (glyph refuses a missing glyph and has no per-glyph fallback).
// Pinned by commit and sha256; glyph fetches it only for a spec that uses it. NOTO_RANGES: the code points both weights map
// (fontTools getBestCmap of these exact files, 2965 code points). Text neither font covers (CJK…): src/og.ts shows coordinates.
const NOTO = "https://raw.githubusercontent.com/notofonts/notofonts.github.io/412a7edb2c8c535d1066157e5b17e661fd5591fe/fonts/NotoSans/unhinted/ttf/NotoSans-"
export const NOTO_FONTS = {
  regular: { url: NOTO + "Regular.ttf", sha256: "f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8" },
  bold: { url: NOTO + "Bold.ttf", sha256: "87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9" },
} as const
const NOTO_RANGES = "0,d,20-7e,a0-377,37a-37f,384-38a,38c,38e-3a1,3a3-3e1,3f0-52f,10fb,1ab0-1ac0,1ac5,1ac7-1ace,1c80-1c88,1d00-1df9,1dfb-1f15,1f18-1f1d,1f20-1f45,1f48-1f4d,1f50-1f57,1f59,1f5b,1f5d,1f5f-1f7d,1f80-1fb4,1fb6-1fc4,1fc6-1fd3,1fd6-1fdb,1fdd-1fef,1ff2-1ff4,1ff6-1ffe,2000-2064,2066-2071,2074-208e,2090-209c,20a0-20c0,20f0,2100-215f,2183-2184,2189,2212,25cc,2c60-2c7f,2de0-2e5d,a640-a69f,a700-a7ca,a7d0-a7d1,a7d3,a7d5-a7d9,a7f2-a7ff,a92e,ab30-ab6b,fb00-fb06,fe00,fe20-fe2f,feff,fffc-fffd,10780-10785,10787-107b0,107b2-107ba,1df00-1df1e"
const NR = NOTO_RANGES.split(",").map(r => { const [a = "", b = a] = r.split("-"); return [parseInt(a, 16), parseInt(b, 16)] as const })
export const notoHas = (c: string) => { const cp = c.codePointAt(0)!; return NR.some(([a, b]) => cp >= a && cp <= b) }
