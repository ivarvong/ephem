# ephem — where are the Sun and the Moon?

A small, proven API: apparent topocentric positions of the Sun and Moon, the day's rise/set/transit/twilight/golden-hour
events, Moon phase, and landmark alignments ("where do I stand to see the Moon behind the Statue of Liberty, and when").
Pure TypeScript on JPL DE440, served from a Cloudflare Worker with Effect v4 `HttpApi`.

## Layout

| Package | Role | Depends on |
| --- | --- | --- |
| `@ephem/core` | pure functions: DE440 block evaluator, time scales, IAU 2006/2000 frames, observer, refraction, geodesics, events, alignment | nothing |
| `@ephem/api` | the HTTP contract as an Effect `HttpApi` value (schemas, conventions, OpenAPI) | effect |
| `@ephem/worker` | handlers + block cache tiers (L1 isolate LRU → L2 Workers Cache → L3 R2 range read); `Admin` RPC that pulls DE440 from JPL into R2; Node dev server | core, api |
| `reference/oracle` | independent Skyfield implementation of the same contract, and a field-by-field cross-check harness | Python |

## Proof

1. `packages/core/test/de440.testpo.test.ts` — the block evaluator against JPL's own `testpo.440`: 92 rows, worst 7.1e-15 au.
2. `packages/core/test/oracle.test.ts` — core against the frozen Skyfield oracle (`fixtures/oracle.json`, spec ephem-oracle/3):
   116 positions over 1972–2149 (incl. heights above MSL and ellipsoid, sea / geometric / numeric horizons, T/P, null apparent
   altitudes below the horizon, altitude/azimuth rates against Skyfield's analytic rates), 81 observer-days (incl. Tromsø and
   Reykjavík; 0 / 320 m, limbs, T/P, horizon profiles), 11 crossing windows, 2 alignment tracks. Angles ≤ 1e-5°, events ≤ 46 ms,
   rates ≤ 1.2e-5 °/min, geoid ≤ 3 mm.
3. `packages/core/test/properties.test.ts` — invariants (fast-check): refraction is 0.98685 × Skyfield's Bennett everywhere,
   continuous and monotone down to the horizon, null exactly below it, exactly 34′ at 0° with defaults; /v1/crossing at
   apparent 0° (upper limb) equals /v1/day's rise/set to ≤ 1 ms; rates
   match finite differences of the API's own positions; higher eyes rise earlier; limb order; profile interpolation; alignment
   self-consistency to 1e-7°.
4. `packages/core/test/geoid.test.ts` — EGM96 against NGA: 403 grid nodes equal `WW15MGH.GRD` to the cm, NGA's published test
   points ≤ 0.25 m, 2 000 points vs the 15′ grid within the stated rms/max.
5. `packages/core/test/geodesic.test.ts` — Vincenty vs GeographicLib on 400 random geodesics: ≤ 1 mm.
6. `reference/oracle/crosscheck.py --a <oracle> --b <deployment>` — the live diff with stated tolerances over positions, days,
   crossings, alignments and rejected requests (unknown or invalid parameters must be 4xx in both). Last run: 0 failures.

The oracle is independent where it matters: Skyfield (SPK, IAU 2000A) for astronomy, its own solver for the contract's one refraction model
(bisection, not fixed-point), its own profile interpolation (`numpy.interp`, periodic), Skyfield's analytic rates,
and EGM96 read from PROJ's GeoTIFF through pyproj (`reference/geoid/fetch.sh` fetches and pins both NGA and PROJ files).

## Run

    npm install && npm test
    python3 reference/oracle/server.py --port 8440                      # Skyfield oracle (needs reference/terrain_sunset/inputs/de440s.bsp)
    curl -o data/jpl/linux_p1550p2650.440 https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440
    node --experimental-strip-types packages/worker/src/dev.ts 8787    # our implementation, locally
    python3 reference/oracle/crosscheck.py --a http://127.0.0.1:8440 --b http://127.0.0.1:8787

## Deploy

    npx wrangler r2 bucket create ephem-de440
    npx wrangler deploy -c packages/worker/wrangler.jsonc              # 516 KiB / 167 KiB gzip
    npx wrangler dev -c packages/worker/ops/wrangler.jsonc             # local caller → deployed ephem#Admin (RPC)
    curl localhost:8788/ingest                                         # JPL → R2, SHA-256 verified by R2, idempotent
    curl localhost:8788/status

## Conventions

Every quantity's definition is in `packages/api/src/index.ts` (`CONVENTIONS`) and in `/openapi.json` of any deployment.

## Guides

- [Build a reproducible ephem MCP chart and inspect it inline in pi](docs/pi-mcp-mpl.md)

## License

MIT (see `LICENSE`), except for the following:
- **Ephem DIN** is a subset of D-DIN © 2017 Datto Inc., modified and renamed as the SIL Open Font License 1.1 requires (`licenses/OFL-D-DIN.txt`; built by `scripts/fonts/din.py` into `packages/web/src/fonts/*.woff2`, self-hosted by the page and served at `/licenses/din.txt` with it).
- **/docs/interactive** loads Scalar's API reference (`@scalar/api-reference@1.74.0`, MIT) from jsDelivr at runtime, pinned by version and SRI; it is not vendored or bundled. The page's npm dependencies (Preact, @preact/signals, preact-render-to-string, Tailwind CSS, Vite) are MIT and installed through npm.
- **Third-party data** included for tests and the bundled model, all from US government sources and in the public domain:
  - JPL DE440 test blocks and test points;
  - the NGA EGM96 geoid;
  - the NOAA WMM2025 coefficients;
  - a METAR snapshot from aviationweather.gov.
