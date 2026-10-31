// Ephem DIN for glyph: glyph fetches fonts by https URL, pinned by sha256, so the front door serves the page's own inline font
// (src/din.ts) at immutable, content-addressed paths: /assets/<sha256[0:16]>/ephem-din-{regular,bold}.woff2.
// test/og.test.ts checks these hashes against the bytes, so regenerating src/din.ts without updating them fails the gate.
import { DIN_BOLD_B64, DIN_REGULAR_B64 } from "./din.ts"

export const OG_ORIGIN = "https://ephem.ivar.workers.dev"   // glyph fetches from the public host (any version serves these bytes)
export const DIN_SHA256 = {
  regular: "7dd8d6ff43f63a1500c8d03b603ec1a544077fb0fe8c235078f70e4a1e88b52c",
  bold: "be98805c53d4c9f9079c66579c17882fbf5b0c29327731c31ee2c3ecbdb805e8",
} as const
export const fontPath = (w: "regular" | "bold") => `/assets/${DIN_SHA256[w].slice(0, 16)}/ephem-din-${w}.woff2`
export const OG_FONTS = {
  regular: { url: OG_ORIGIN + fontPath("regular"), sha256: DIN_SHA256.regular },
  bold: { url: OG_ORIGIN + fontPath("bold"), sha256: DIN_SHA256.bold },
} as const
const B64 = { regular: DIN_REGULAR_B64, bold: DIN_BOLD_B64 } as const
let bytes: Partial<Record<"regular" | "bold", Uint8Array<ArrayBuffer>>> = {}
export const fontBytes = (w: "regular" | "bold"): Uint8Array<ArrayBuffer> => (bytes[w] ??= Uint8Array.from(atob(B64[w]), c => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>)
export const resetFontBytes = () => { bytes = {} }
