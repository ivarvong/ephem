// ephem-tail: receives ephem's tail events (tail_consumers) and sends one row per invocation to the Basin stream ephem_invocations.
import { routeCounts, shapeOf, toRow, type InvocationRow, type TailItemLike } from "./row.ts"

interface Env {
  readonly INVOCATIONS: { send(records: ReadonlyArray<InvocationRow>): Promise<void> }
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void
}

let shapeLogged = false

export default {
  async tail(events: ReadonlyArray<TailItemLike>, env: Env, ctx: Ctx): Promise<void> {
    if (!shapeLogged && events.length) {
      shapeLogged = true
      console.log(JSON.stringify({ tail_item_shape: shapeOf(events[0]) }))
    }
    const rows = events.map((e) => toRow(e))
    if (!rows.length) return
    // Route labels per batch (labels and counts only), so the labelling is checkable from the tail's own logs without Basin SQL.
    console.log(JSON.stringify({ tail_batch: { rows: rows.length, routes: routeCounts(rows) } }))
    ctx.waitUntil(
      env.INVOCATIONS.send(rows).catch((e: unknown) =>
        console.error(
          JSON.stringify({
            basin_send_failed: {
              stream: "ephem_invocations",
              rows: rows.length,
              error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
            },
          }),
        ),
      ),
    )
  },
}
