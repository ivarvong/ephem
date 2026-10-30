// W3C traceparent parsing, no imports (src/responses.ts and src/clienttrace.ts both use it). See src/clienttrace.ts.
const TP = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/** The (trace id, span id) of a valid version-00 traceparent; all-zero ids are invalid (W3C §3.2.2.3). */
export const parseTraceparent = (h: string | undefined | null): { traceId: string; spanId: string } | undefined => {
  if (!h || h.length !== 55) return undefined
  const m = TP.exec(h)
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined
  return { traceId: m[1]!, spanId: m[2]! }
}
