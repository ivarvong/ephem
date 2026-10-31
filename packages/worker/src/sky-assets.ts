// The homepage's DE440 blocks for its in-browser compute, served by the front door (content-addressed, immutable; not part of
// the /v1 API). The page's code itself (@ephem/core bundled by @ephem/web) is a static asset.
//   GET /assets/de440/<de440 sha256[0:16]>/<i>  DE440 block i, 8 144 B, the bytes the API reads: through the Blocks service
//                                               (isolate LRU → BlockStore loopback → Workers Cache → R2, src/blocks.ts).
// A pure function of its URL, so `public, max-age=31536000, immutable`: a returning browser has them in its cache.
// Span: assets.block (block, cache tier) under the request's root span.
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { DE440 } from "@ephem/core"
import { Blocks, blocksCache } from "./blocks.ts"
import { IMMUTABLE } from "./responses.ts"

export const DE440_SHA16 = DE440.sha256.slice(0, 16)
/** Block i is at DE440_ASSET_BASE + i. */
export const DE440_ASSET_BASE = `/assets/de440/${DE440_SHA16}/`

const notFound = (msg: string) =>
  HttpServerResponse.text(msg, { status: 404, headers: { "cache-control": "no-store" } })

export const SkyAssets = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const blocks = yield* Blocks // the front door's (src/app.ts provideApp), captured when the routes are built
    yield* router.add(
      "GET",
      "/assets/de440/:sha/:i",
      Effect.gen(function* () {
        const p = yield* HttpRouter.params
        const i = /^\d{1,5}$/.test(p.i ?? "") ? Number(p.i) : NaN
        if (p.sha !== DE440_SHA16)
          return notFound(`no DE440 file ${p.sha ?? ""}: this server has ${DE440_SHA16} (${DE440.file})`)
        if (!Number.isInteger(i) || i < 0 || i >= DE440.nBlocks)
          return notFound(`no block ${p.i ?? ""}: DE440 blocks are 0..${DE440.nBlocks - 1}`)
        yield* Effect.annotateCurrentSpan({ "assets.block": i })
        const loaded = yield* blocks.load([i]).pipe(Effect.orDie)
        yield* Effect.annotateCurrentSpan({ "ephem.blocks_cache": blocksCache(loaded.stats) })
        return HttpServerResponse.uint8Array(new Uint8Array(loaded.src(i)), {
          contentType: "application/octet-stream",
          headers: { "cache-control": IMMUTABLE },
        })
      }).pipe(Effect.withSpan("assets.block")),
    )
  }),
)
