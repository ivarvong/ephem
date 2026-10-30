# ephem — design notes

*Status 2026-10-29 (API-correctness pass: §§7, 8, 11, 13, 14). Originally 2026-10-28. Commit `ba113d4` plus this document. Everything described here is implemented and tested unless marked **open**.*

## 1. Purpose

A general-purpose "where are the Sun and the Moon" API: apparent topocentric positions, the day's events (rise, set,
transit, twilight, golden and blue hour), Moon phase, and landmark alignments — where to stand so a body appears behind a
landmark, and from a fixed spot, when it does. Deterministic, pure TypeScript on JPL DE440, served from a Cloudflare
Worker through an Effect v4 `HttpApi`, and proven against an independent implementation rather than trusted.

Design rules, in priority order:

1. **Proven.** Every number has an independent reference (JPL's own test vectors, Skyfield, GeographicLib, zoneinfo) and a
   stated tolerance. "Works" means the cross-check harness reports zero failures.
2. **Simple.** Pure functions over immutable inputs; one I/O boundary (`BlockSource`); one contract value; no framework
   in the maths.
3. **Instrumented.** Every response says which blocks it read, how long compute took, and which cache tiers served it.
4. **Better.** Exact where exactness is cheap (IAU 2006 precession, DE440's own nutation, relativistic aberration,
   WGS-84 ECEF), and honest about the rest (§14).

## 2. Architecture

```
clients ──HTTPS──▶ @ephem/worker ──implements──▶ @ephem/api (HttpApi value, OpenAPI)
                        │ calls
                        ▼
                   @ephem/core  (pure: block evaluator → frames → observer → events / alignment)
                        │ reads (synchronous, prefetched)
                        ▼
                   DE440 blocks  (R2: one 102 MB object, exact byte-range reads; filled by the Admin RPC)

reference/oracle/server.py  ──implements──▶ the same contract, with Skyfield + DE440s + pyproj
reference/oracle/crosscheck.py  diffs any two implementations field by field
```

| Package | Contents | May import |
| --- | --- | --- |
| `@ephem/core` | `block` (DE440 record evaluator) · `time` · `linalg` · `frames` · `ephemeris` · `observe` · `geodesic` · `position` · `day` · `alignment` | nothing |
| `@ephem/api` | `EphemApi` (groups `sky`, `meta`), request/response schemas, tagged errors, `CONVENTIONS` | `effect` |
| `@ephem/worker` | `handlers` (decode → block set → load → core → diagnostics) · `blocks` (cache tiers) · `app` (router, CORS, explained 400s, `/docs`) · `ingest` + `admin` (JPL → R2 RPC) · `index` (Workers entry) · `dev` (Node server) · `ops/` (local-only RPC caller) | core, api, effect |

The dependency rule is one-way and mechanical: core's `package.json` lists no dependencies; `tsc -p packages/core` fails
if anything else is imported. Core is runtime-agnostic (Workers, Node, browsers, Bun, Deno) because it does no I/O: the
caller resolves the block indices it will need (`blocksFor`) and hands core a synchronous `BlockSource`.

## 3. Data: JPL DE440

**File.** `linux_p1550p2650.440` (102 272 352 bytes), JPL SSD's "Linux binary" distribution of DE440. It is already
time-indexed: two 8 144-byte header records, then 12 556 records of 8 144 bytes, each covering 32 days and holding
Chebyshev coefficients for all bodies in that window, plus nutations (Δψ, Δε), librations and TT−TDB. Block *i* covers
JD 2287184.5 + 32 i. The SPK (`.bsp`) form is the same numbers in NAIF's DAF container, one array per body, which would
need 11 scattered reads per instant and a directory parse; the Linux layout needs one read. Both are official products of
the same integration and agree to the last bit.

**Record layout** (`ipt`, 1-based double offsets; `coefficients × sub-intervals`): Mercury 3/14×4 · Venus 171/10×2 ·
EMB 231/13×2 · Mars 309/11×1 · Jupiter 342/8×1 · Saturn 366/7×1 · Uranus 387/6×1 · Neptune 405/6×1 · Pluto 423/6×1 ·
**Moon 441/13×8 (geocentric)** · Sun 753/11×2 · nutations 819/10×4 (2 components) · librations 899/10×4. Earth is never
stored: `earth_ssb = EMB − moon_geo / (1 + EMRAT)`, EMRAT = 81.30056822149722. These constants are baked into
`block.ts`, so the Worker does zero I/O before its first block read.

**Evaluation.** `evalBlock(block, body, jdTdb)`: pick the sub-interval, map time to τ ∈ [−1, 1], Chebyshev T_k and T′_k
by recurrence, sum coefficients per axis. Velocity is the derivative scaled by 2/subDays. Verified against JPL's
`testpo.440` (§13.1).

**Supported range.** 1972-01-01 to 2149-12-31 UTC: 1972 is where UTC with leap seconds begins (before that, TAI−UTC is
not an integer and the model here is undefined); 2150 is the end of `de440s` (the oracle's file). Blocks 4808–6855.

**Storage: R2, one object, range reads.** The Worker keeps the file byte-for-byte as JPL publishes it, at
`ephem-de440/de440/linux_p1550p2650.440`. Block *i* is the exact range `[(2+i)·8144, (3+i)·8144)`; a request reads only
the blocks it needs, and consecutive misses coalesce into one ranged `get`. No repack, no build step, no asset upload,
and the whole 1550–2650 file is available (the API still limits requests to 1972–2150, see above). The deployed Worker
is code only: **516 KiB / 167 KiB gzip**.

**Ingest: `Admin` RPC entrypoint** (`admin.ts`, logic in `ingest.ts`). `Admin.ingest({ force? })`:

1. `head` the object; if its size is 102 272 352 and its `customMetadata.sha256` equals the pinned hash, return
   `already-present` without touching JPL (idempotent; safe to call from a cron or by hand).
2. `fetch(DE440.url)`; refuse unless `content-length` is exactly the pinned size (before any write).
3. Stream the body through `FixedLengthStream` into `bucket.put(key, body, { sha256 })`. R2 computes SHA-256 server-side
   and **rejects the put if it differs**, so a truncated or altered download never becomes an object. Memory stays flat;
   the 102 MB never sits in the isolate.
4. Re-read the stored header and blocks 0 and 12 555 by range, parse the header (`ncon`, `au`, `EMRAT`, `ipt`, `numde`)
   and check it against the constants compiled into core, so the bytes R2 serves are the bytes core was verified on.

The pin (`url`, `sizeBytes`, `sha256`, `numde`) lives in `DE440` in `packages/core/src/block.ts`; it matches
github.com/ivarvong/de440. `Admin` is not reachable over HTTP: it is a named `WorkerEntrypoint`, callable only through a
service binding. `packages/worker/ops/` is a never-deployed Worker that binds to it remotely, so an operator runs
`wrangler dev` locally and `curl`s `/status` or `/ingest`.

## 4. Time scales (`time.ts`)

Input: UTC as Unix milliseconds, plus `dut1 = UT1 − UTC` (request parameter, default 0, |dut1| ≤ 0.9 s).

- TAI − UTC from the IERS leap-second table (28 entries, 1972-01-01 … 2017-01-01, currently 37 s).
- TT = TAI + 32.184 s. ΔT reported as TT − UT1.
- TDB − TT from USNO Circular 179 eq. 2.6 (seven periodic terms, ≤ 2 ms, accurate to ~10 µs). DE440 is read at TDB.
- UT1 = UTC + dut1. Earth rotation uses UT1; a wrong dut1 costs 15″ of hour angle per second.

Checked: `taiMinusUtc` at the 2017 boundary; `deltaT` reproduces Skyfield's to 1e-9 s when its own dut1 is passed.

## 5. Celestial frames (`frames.ts`)

ICRS → true equator and equinox of date, M = N · P · B, matching Skyfield's `Time.M` term for term:

- **B**, frame bias (ICRS → J2000 mean): IERS 2003 ξ₀ = −0.0166170″, η₀ = −0.0068192″, dα₀ = −0.01460″, second-order
  matrix.
- **P**, precession (Capitaine et al. 2003, P03 four-angle form): R3(χ_A) · R1(−ω_A) · R3(−ψ_A) · R1(ε₀), ε₀ = 84381.406″.
- **N**, nutation: from Δψ, Δε **read off the DE440 block** (body 11) rather than the IAU 2000A series — full
  precision for free, and identical in both implementations.
- Mean obliquity, IAU 2006 polynomial. True obliquity = mean + Δε.
- **GMST**: Earth rotation angle (IAU 2000 B1.8, from UT1) plus the Capitaine 2003 eq. 42 polynomial in TDB centuries.
- **GAST** = GMST + Δψ cos ε_mean + complementary terms (two leading terms of IERS 2010 Table 5.2e; the omitted terms
  are below 1 µas).
- **C** = R3(−GAST) · M: ICRS → ITRS, no polar motion (see §14).
- Ecliptic of date: R1(−ε_true) · M.

Rotation helpers are *active* rotations (`rotX/rotZ` rotate a vector by +θ), the same convention as Skyfield's
`rot_x/rot_z`, which matters for getting signs right in P and C.

## 6. Observer and apparent place (`observe.ts`)

- Observer: WGS-84 geodetic → ITRS (km), with the geodetic normal as "up"; ENU basis for azimuth/altitude. `height` is
  **above the ellipsoid** by default; `heightRef=msl` makes it above the EGM96 geoid (≈ mean sea level), and with no height
  the observer stands on the geoid. Every sky response returns `heightEllipsoid`, `heightMsl` and `geoidUndulation`
  (`geoid.ts`, §7.2).
- Observer velocity = Earth's barycentric velocity + ω × r (diurnal), ω = 7.292115e-5 rad/s.
- Astrometric vector: iterate light time `lt = |body(t − lt) − obs| / c` to 1e-12 d (Sun 499 s, Moon 1.3 s).
- Aberration: the relativistic NOVAS/Skyfield `add_aberration` form (annual + diurnal, O(β²) terms kept).
- Topocentric RA/Dec of date from M · v; azimuth/altitude from the ENU projection of C · v; hour angle = GAST + λ − RA.
- Geocentric apparent ecliptic longitude/latitude for the phase and "where is it in the zodiac".
- Angular radius: Sun 959.63″/r_au; Moon asin(1737.4 km / d).

Gravitational light deflection is **not** applied (Skyfield does, via `apparent()`); for the Sun and Moon it is below
0.002″ and invisible at the 1e-4° tolerance. Noted in §14.

## 7. Refraction, horizon and heights (`horizon.ts`, `geoid.ts`; 2026-10-29)

**One refraction model, every endpoint** (`refraction` in `horizon.ts`; ivar 2026-10-29: "34′ is fine for now"):
R(a) = 34′·(P/1010)·(283/(273 + T))·cot(a + 7.31/(a + 4.4))/cot(7.31/4.4) for apparent altitude a ∈ [a*, 89.9°], 0 above.
That is Bennett's (1982) shape normalised to the almanac's 34′ at the horizon for 10 °C / 1010 hPa: a constant 0.98685 ×
Skyfield's Bennett (`0.28·P/(T + 273)` form) at every altitude, 0.45′ less at 0°, 0.07′ less at 10°. Before 2026-10-29
/v1/position used Skyfield's Bennett and /v1/day a fixed 34′, so `crossing?altitude=0&altitudeType=apparent&limb=upper` and
/v1/day's sunrise differed by 2.3–6.7 s (prod b49a8a02: NYC 2.5 s, Sydney 2.3 s, Tromsø 6.7 s); now they agree to ≤ 1 ms
(property test). `apparentAltitude` is the fixed point a = h + R(a) (1e-9°); rise/set is the chosen limb's true altitude =
H − R(H); /v1/alignment's solver uses the same model (`refractTrue`: no refraction only below the floor, which alignment
never reports).

**Domain.** Applied **down to the observer's horizon** (`horizon`: the sea horizon −dip by default, 0° for `geometric`, or a
given angle) and never below a* = √7.31 − 4.4 = −1.6963°, where Bennett's shape peaks and starts to fall (unphysical).
Below max(horizon, a*) the value is **null**. Before 2026-10-29 refraction was cut at −1° apparent, so below that the
"apparent" value silently repeated the true altitude.

**Dip.** dip = √(1 − k)·acos(R/(R + h_msl)), k = 0.13 (the terrestrial refraction coefficient /v1/alignment uses),
R = 6 371 008.8 m: ≈ 1.797′·√h. 0 at or below sea level.

**Evidence: how good is Bennett below 0°?** A 2-D ray trace through the US Standard Atmosphere 1976 (sea level 10 °C,
1010 hPa; Edlén refractivity; `reference/terrain_sunset/terrain_sunset.py`'s tracer with the sea surface at 0 m):

| eye above sea | ray-traced horizon | dip, k = 0.13 | refraction at the horizon: ray trace | Skyfield's Bennett | this model |
| --- | --- | --- | --- | --- | --- |
| 0 m | 0.00′ | 0.00′ | 33.89′ | 34.45′ | 34.00′ |
| 10 m | −5.53′ | 5.68′ | 35.06′ | 35.67′ | 35.20′ |
| 100 m | −17.50′ | 17.97′ | 37.60′ | 38.48′ | 37.98′ |
| 320 m | −31.33′ | 32.14′ | 40.49′ | 42.00′ | 41.45′ |
| 1 000 m | −55.52′ | 56.81′ | 45.35′ | 48.58′ | 47.95′ |
| 3 000 m | −96.86′ | 98.38′ | 52.74′ | 56.69′ | 55.95′ |

So for eyes up to ~1 km the model is within ~1–3′ of a standard atmosphere, and the k = 0.13 dip is ≈ 2.5 % larger than the
standard atmosphere's (whose k ≈ 0.17). The real atmosphere near the horizon differs from any standard one by more than
that: the lowest few hundred metres' temperature gradient sets the refraction, and inversions or a warm surface change it by
tens of arcminutes. Treat sub-arcminute horizon differences as model, not sky. Sea horizons below a* (eyes above ≈ 3.2 km
MSL) are refused on /v1/day with a 422 that says so; /v1/position returns null there.

### 7.2 Geoid (EGM96)

NGA's official 15′ grid (`WW15MGH.GRD`, earth-info.nga.mil "egm-96interpolation", SHA-256 pinned in
`reference/geoid/inputs.sha256`) is subsampled to 30′ (361 × 720 nodes), rounded to 1 cm, and bundled
(`egm96-grid.ts`: 46 bands of 8 rows, each planar-predictor residuals as zigzag varints, base64: 384 KB raw / 258 KB gzip; a
lookup decodes only the ≤ 2 bands it touches, once per isolate, 0.6 ms in Node; the single stream before 2026-10-30 cost every
fresh isolate a 260 k-node decode, ~7 ms). Bilinear between nodes. Interpolation error against bilinear on the full 15′ grid (2 M area-uniform points):
rms 0.12 m, p99 0.49 m, p99.9 1.06 m, max 3.48 m. Against NGA's published `OUTINTPT.DAT` test points: ≤ 0.244 m. For the dip
this is negligible (1 m at 10 m changes the dip by 0.28′). Tests: `geoid.test.ts` (403 nodes equal NGA's values to the cm,
NGA's test points, 2 000 points vs the 15′ grid). The oracle reads the same NGA grid from PROJ's GeoTIFF
(`us_nga_egm96_15.tif`) through pyproj, with its own bilinear: agreement ≤ 3 mm.

## 8. Day events (`day.ts`)

Window: local midnight to local midnight of the requested date in the IANA zone, computed with `Intl` only (Workers ship
full ICU). A skipped midnight (DST at 00:00, e.g. America/Santiago) maps to the first instant of that date; checked
against Python's `zoneinfo` over 3 718 zone-days (§13.5).

| Event | Definition |
| --- | --- |
| rise / set | the chosen limb (`limb`, default upper) at apparent altitude H = the horizon (§7): true limb altitude = H − R_rs(H); with a `horizonProfile`, H is the profile at the body's azimuth (linear in azimuth, wrapping through north) |
| transit | upper culmination: sin(hour angle) rising through zero |
| civil / nautical / astronomical dawn & dusk | Sun centre true altitude crosses −6° / −12° / −18° |
| golden hour | Sun centre true altitude in [−4°, +6°]; blue hour in [−6°, −4°] — start/end events at the boundaries |

Every /v1/day response states these in `conventions` (limb, horizon kind/altitude/dip, refraction model/T/P/at-horizon,
true limb altitude, the twilight/golden/blue thresholds, the geoid). **/v1/crossing** uses the same sampler and root finder
for any altitude (true or apparent), limb and direction, over a start/end window (≤ 31 days) or a local date + tz, and gives
each crossing's azimuth and altitude rate.

**Rates.** `altitudeRate`, `azimuthRate` (°/min) in /v1/position: symmetric difference over ±10 s (truncation < 1e-7 °/min
away from the zenith). Near the zenith altitude has a cusp and azimuth
spins, so both rates are only meaningful a degree or more away from it. Checked against ±2 s differences of the API's own positions and against Skyfield's analytic
`frame_latlon_and_rates` (≤ 1.5e-6 °/min altitude, ≤ 1.2e-5 °/min azimuth).

**Root finding.** Sample every 5 min (20 min for transit), bisect every sign change to 0.1 ms. Grazing events (the Sun
skimming the horizon without a sign change at two consecutive samples) are caught by a golden-section search for the
nearest approach between three samples; if it crosses zero, two roots are bisected either side. Both implementations
use the same definition, so a polar day with a grazing Sun yields the same event set.

## 9. Moon phase (`position.ts`)

Geocentric, Skyfield's definitions: phase angle = angle Sun–Moon–Earth using the light-time-corrected Moon and the
un-retarded Sun; illuminated fraction = (1 + cos i)/2; elongation = λ_☾ − λ_☉ (apparent ecliptic longitudes of date)
in [0, 360); bright-limb position angle from geocentric apparent RA/Dec (Meeus 48.5); name by 45° sectors of elongation
centred on new/quarter/full.

## 10. Geodesy and alignment

**Geodesics (`geodesic.ts`).** Vincenty direct and inverse on WGS-84, 1e-13 rad convergence, antipodal guard. Against
GeographicLib (Karney) on 400 random geodesics of 1 m … 200 km: ≤ 1 mm in position and distance, azimuth error × distance
≤ 0.1 mm. Karney would be needed only for near-antipodal pairs, which the API never asks for (≤ 200 km).

**Alignment (`alignment.ts`).** Unknown standing point P at eye height h_o; landmark top T at height h_t. At time t:

1. azimuth of the body seen from P = forward geodesic azimuth P → T;
2. apparent altitude of the body at P = apparent elevation of T from P, where apparent elevation = geometric elevation
   (exact WGS-84 ECEF vectors) + k·θ/2, k = 0.13, θ = geodesic distance / 6 371 008.8 m (standard terrestrial refraction).

Solver: start at T; look at the body; bisect the distance along the back-azimuth until (2) holds (to 1e-7 m, so the
elevation residual stays below 1e-7° even 100 m from the target); compute the true forward azimuth P → T; rotate the
back-azimuth by the residual; repeat until the azimuth residual < 1e-9° and P moved < 1 mm. Converges in 4–6 passes.
Points are omitted when the body is below −1° or no P lies within `maxDistanceKm`. The property test re-evaluates every
returned point and demands (1) and (2) to 1e-7°.

**Heights (2026-10-30).** `observerHeight` (`heightRef`) and `targetHeight` (`targetHeightRef`) are metres above the
ellipsoid by default and above the EGM96 geoid with `msl`, as on every endpoint; without `observerHeight` the eye is on the
geoid (heightMsl 0; before 2026-10-30 it was 0 m above the ellipsoid). With `heightRef=msl` the eye's ellipsoidal height is
`observerHeight + N(P)` at every candidate point inside the solver, so N varies along the track (cm per km here). Each track
point reports `heightEllipsoid`, `heightMsl`, `geoidUndulation`, and the body's `altitudeRate` / `azimuthRate` seen from that
point (±10 s, as /v1/position); `target` echoes the target's heights; a `conventions` block states the solve, what
`azimuth` means, terrestrial refraction (modelled: constant k = 0.13 along the sight line), refraction and heights. The
Worker prefetches the geoid bands for target lat ± maxDistanceKm. Evidence: the customer's Statue of Liberty repro
(2026-11-17T03:44:30–03:46:00Z) in ellipsoidal heights (their hand-copied N = −32.81 m) and in msl heights (70 m / 5 m)
agree to ≤ 8.5 m along a 12 m/s track (N at the statue is −32.90 m, so their target was 0.09 m high); vs the Skyfield
oracle with msl heights: position ≤ 25 mm, heightEllipsoid ≤ 1.8 mm (`crosscheck.py --only alignment`, 0 failures).

**Context (`include=sun,phase`, 2026-10-30).** On /v1/alignment (each track point and pass) and /v1/crossing (each
crossing): `sun` = the Sun's azimuth, true altitude and apparent altitude (sea horizon at the eye's height, else null) seen
from that point at that instant, and `phase` = the Moon's geocentric phase, both exactly /v1/position's values there
(worker test). Replaces the customer's per-pass /v1/position calls. Answers without `include` are unchanged (no
CACHE_VERSION bump).

**Converse ("from here, when").** With `observerLat/Lon`: the azimuth to the target and its apparent elevation are fixed;
find the instants where the body's azimuth − target azimuth crosses zero (2-min sampling, ±180° wrap crossings
discarded), and report `altitudeOffset` = body apparent altitude − target elevation. Negative means the body centre is
below the target's top, i.e. behind it; compare with `angularRadius` for partial occultation.

## 11. The contract (`@ephem/api`)

`EphemApi = HttpApi.make("ephem").add(sky, meta)` with `GET /v1/position`, `GET /v1/day`, `GET /v1/alignment`,
`GET /v1/crossing`, `GET /v1/track` (Sun/Moon azimuth, true and apparent altitude on a UTC grid, columnar; each sample equals
`/v1/position` at that instant; ≤ 8 days and ≤ 1 441 samples, step 60–3600 s, start/end on the step's grid), `GET /healthz`, plus `/openapi.json` generated from the same value and `/docs` (Scalar from jsDelivr, pointed at it). Query parameters decode through
`FiniteFromString` with range checks; `UtcString` and `DateString` are regex-checked. `CONVENTIONS` in the same file is
the human-readable definition of every quantity and is reproduced in this document's §§4–10.

Unknown query parameters are rejected (`HttpApi.QueryParseOptions: onExcessProperty "error"`); the router turns that into
`400 { _tag: "InvalidRequest", kind: "UnknownParameter", unknown, allowed }` (allowed set from `QUERY_PARAMS`, derived from
the endpoint schemas). Before 2026-10-29 `/v1/day?temperature=…` was accepted and ignored.

Errors are tagged Schema classes with HTTP status annotations: `OutOfRange` (422: time outside 1972–2149),
`InvalidInput` (422: unknown zone, end ≤ start, > 2000 steps, half an observer). Request-decoding failures, which the
runtime would render as an empty 400, are turned into `{ _tag: "InvalidRequest", kind, message }` by a router
middleware so a caller learns *which* field failed.

Every success carries `provenance: { implementation, version, ephemeris, diagnostics: { blocks, computeMs, cache: { l1, l2, l3, reads } } }`.

## 12. Worker runtime (`@ephem/worker`)

**Request path.** decode → `blocksFor(jdFrom, jdTo)` (±0.01 d light-time margin) → `Blocks.load` (prefetch blocks) →
`instrumented(src)` → pure core → attach diagnostics. Spans: `position|day|alignment` ⊃ `blocks.load`, `compute`, with
attributes (`computeMs`, `blocks`, `reads`, `l1/l2/l3`) for Workers tracing; `Server-Timing: total;dur=…` on every
response; CORS `*` for browser clients; `OPTIONS` answered before routing.

**Block cache tiers** (`blocks.ts`), keyed per block (8 144 B, the smallest unit DE440 has):

| Tier | Where | Key | Hit cost | Eviction |
| --- | --- | --- | --- | --- |
| L1 | in-isolate LRU, 512 blocks (4.2 MB, ~45 years) | block index | ~0 | LRU; isolates are recycled anyway |
| L2 | Workers Cache `caches.default` | `https://eph.internal/de440/<sha256[:16]>/<i>` | ~1 ms, per colo | `max-age=31536000, immutable` |
| L3 | R2 `get(key, { range })` | byte range | one round trip per run of misses | n/a |

L2 lookups run in parallel; the remaining misses are grouped into runs of consecutive indices and each run is one R2
range read (a typical request needs 1–2 blocks; a 32-day `/v1/day` window spans at most 2). L2 writes go through
`waitUntil`, off the response path. The cache key carries the file hash, so a different ephemeris can never be served
from an old entry. In-flight de-duplication per block; failed loads are not memoised; the range length is checked on
arrival, and each block's own JD header is checked against its index before use or caching, so an offset error can
never be cached as truth (tested with a deliberately off-by-one origin). A missing block
is an infrastructure fault and becomes a 500 (`Effect.orDie`), not a typed client error.

**Deployment** (real account):

```
npx wrangler r2 bucket create ephem-de440
npx wrangler deploy -c packages/worker/wrangler.jsonc             # 516 KiB / 167 KiB gzip, minified
npx wrangler dev -c packages/worker/ops/wrangler.jsonc            # local caller, remote binding to ephem#Admin
curl localhost:8788/ingest                                        # JPL → R2, verified; ~102 MB, once
curl localhost:8788/status                                        # { present, sizeBytes, sha256, matchesPinned }
curl https://ephem.<you>.workers.dev/v1/position?lat=40.7&lon=-74&time=2026-10-28T12:00:00Z
```

Until ingest has run, data endpoints return 500 with "R2 object … missing — run the ingest RPC". No `nodejs_compat`.

**Size.** The bundle was 4.3 MB raw / 1.1 MB gzip with `HttpApiScalar.layerCdn`, which inlines ~3.1 MB of Scalar
(73 % of the script). `/docs` is now a ~400-byte page that loads `@scalar/api-reference@1.74.0` from jsDelivr and points
it at `/openapi.json`; with `minify: true` the Worker is 516 KiB / 167 KiB gzip (Effect HttpApi + Schema + core), an
85 % cut.

**Local.** `node --experimental-strip-types packages/worker/src/dev.ts 8787` runs the identical handler on Node with
blocks range-read from a local copy of the DE440 file (`data/jpl/`) with the same `makeBlocks` and the same offsets
as R2; this is what the cross-check harness targets.

### 12.1 Storage sizes, and why R2 rather than a Durable Object

| Unit | Blocks | Bytes |
| --- | --- | --- |
| one block (32 days) | 1 | 8 144 |
| **one year** | 11.41 | **92 956 (90.8 KiB)** |
| supported range 1972–2150 | 2 048 | 16.7 MB |
| full file 1550–2650 | 12 556 | 102.3 MB |

Chebyshev coefficients do not compress (gzip 0.98), so these are wire sizes too.

**Why R2 range reads.** The access pattern is "a few KB at an exact offset of an immutable 102 MB file", which is
what R2 range `get` is. Ingest is one streamed `put` with server-verified SHA-256, and the data never ships with the
code. A Durable Object holding SQLite rows of blocks (the 8 MB row limit would fit ~86 years per row, but rows should
follow fetch granularity) was the alternative: it buys strong consistency and a home for *mutable* data, but it lives in
one location, so every colo's first miss pays a cross-region hop, and it adds a repack and a class for data that never
changes. With Workers Cache per block in front, R2's per-read cost is paid about once per colo per block per year.

The DO is still the right home for what *does* change: DUT1 and the leap-second table from IERS Bulletins A/C, refreshed
weekly by alarm, which `/v1/time` needs (§17). That is independent of the ephemeris path.

## 13. Verification

| # | Test | Reference | Cases | Result |
| --- | --- | --- | --- | --- |
| 1 | `de440.testpo.test.ts` | JPL `testpo.440` | 92 rows 1850–2150, all bodies, nutations, librations | worst 7.1e-15 au (1 ulp at 37 au) |
| 2 | `oracle.test.ts` | frozen Skyfield oracle (`fixtures/oracle.json`, ephem-oracle/3) | 116 instants 1972–2149 (heights MSL/ellipsoid, horizons, T/P, null apparent altitudes, rates); 81 observer-days incl. Tromsø 69.6° N and Reykjavík (heights, limbs, T/P, profiles); 11 crossing windows; 2 alignment tracks + converse | all within tolerance; worst angle 9.8e-6°, worst event 46 ms, rates 1.2e-5 °/min, geoid 3 mm, standing point 21 mm |
| 3 | `properties.test.ts` | invariants (fast-check) | ranges, refraction (= Skyfield above −1°, monotone, null exactly below the horizon), 34′ at sea level, rates vs finite differences, dip ordering, limbs, profiles, phase identities, event ordering, grazing-root finder, alignment self-consistency | pass |
| 3b | `geoid.test.ts` | NGA EGM96 (`WW15MGH.GRD`, `OUTINTPT.DAT`) | 403 nodes, 6 NGA test points, 2 000 points vs the 15′ grid | nodes ≤ 0.005 m; test points ≤ 0.244 m |
| 4 | `geodesic.test.ts` | GeographicLib via pyproj | 400 random geodesics | ≤ 1 mm |
| 5 | `timezone.test.ts` | Python `zoneinfo` | 3 718 zone-days, 11 DST-at-midnight zones | 0 mismatches |
| 6 | `worker.test.ts` | the real HTTP handler | cache tier progression L3→L1→L2, typed errors, round trips, OpenAPI/docs | pass |
| 7 | `crosscheck.py --a oracle --b <local or prod>` | live Skyfield oracle | the default case set (positions, days, crossings, alignments, must-reject requests) | **0 failures** (local and prod b49a8a02, 2026-10-29) |

**Tolerances** (`crosscheck.py` and `oracle.test.ts`): angles 1e-4° (0.36″); RA 1e-4°/15; distance 0.01 km; angular
radius 1e-6°; illuminated fraction 1e-6; JD 1e-9 d; event instants 0.5 s; standing point 1 m; alignment distance 1 m.
The observed deviations are 10–100× inside these, so the tolerances are not tuned to pass.

**Why the oracle is independent.** Different ephemeris container (SPK via jplephem vs Linux binary), different code for
precession-nutation (Skyfield's IAU 2000A series vs DE440's tabulated angles — they agree to microarcseconds), different
geodesy (Karney vs Vincenty), different refraction code path, different root finder implementation, different language.
What is shared by construction: the *definitions* (§§4–10), which is the point of a contract.

**Regenerating fixtures.** Start the oracle, then `python3 reference/oracle/fixtures.py`; it freezes answers for the
default cases and copies the 67 blocks they need into `packages/core/test/fixtures/blocks/` (784 KB), so `npm test` is
offline and needs no JPL access. In CI, `CI=1` makes a missing block a failure rather than a download.

## 14. Known approximations and error budget

| Effect | Size | Status |
| --- | --- | --- |
| Polar motion (ITRS vs the frame used) | ≤ 0.3″ in az/alt | not modelled; matches oracle (also none) |
| UT1 − UTC default 0 | ≤ 0.9 s of rotation ≈ 13″ | caller passes `dut1` from IERS Bulletin A; **open:** serve it from a weekly-refreshed KV |
| Gravitational light deflection | ≤ 0.002″ for Sun/Moon | not modelled; below tolerance |
| Refraction model vs the real atmosphere near the horizon | ±0.05° typical, more with inversions | inherent; the API takes T and P |
| Terrestrial refraction k = 0.13 in alignment | ±0.01° of target elevation at 10 km | inherent; **open:** parameter |
| Horizon refraction model (Bennett below 0°, k = 0.13 dip) | 1–3′ vs a standard atmosphere up to 1 km (§7); real horizon refraction varies by tens of ′ with the weather | stated in every response; T/P are inputs |
| EGM96 30′ bilinear | rms 0.12 m, max 3.5 m | §7.2; negligible for the dip |
| Terrain | minutes for obstructed observers | caller supplies `horizonProfile` (apparent elevations); `reference/terrain_sunset` is the full DEM model |
| Leap seconds after 2017 | none announced | table update on IERS Bulletin C |
| TDB−TT series | ~10 µs | negligible |

## 15. Performance

Node 22 / V8, warm: position (Sun + Moon + phase, two frames) ≈ 2.5 ms; a full day of events ≈ 5–10 ms; a 10-point
alignment track ≈ 40 ms (each point runs 4–6 solver passes, each with a 40-step distance bisection). The Chebyshev
evaluation itself is ~16 µs for Sun + Moon + nutations. Cold: one R2 range read of 8–16 KB per request (1–2 blocks),
then one Workers Cache hit per block per colo.

## 16. Operations

```
npm install && npm test                                         # 229 tests, offline
npx oxlint packages scripts && npm run typecheck
curl -o data/jpl/linux_p1550p2650.440 https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440   # local dev only
python3 reference/oracle/server.py --port 8440                  # oracle (needs de440s.bsp: reference/terrain_sunset/fetch_inputs.sh)
node --experimental-strip-types packages/worker/src/dev.ts 8787
python3 reference/oracle/crosscheck.py --a http://127.0.0.1:8440 --b http://127.0.0.1:8787
npx wrangler deploy -c packages/worker/wrangler.jsonc           # then ingest via ops/ (§12)
node --experimental-strip-types scripts/openapi.ts              # refresh reference/openapi.json after a contract change
```

A contract change is made in three places, in this order: `@ephem/api` (the value), `reference/oracle/server.py` (the
independent implementation), then core/worker; then regenerate fixtures and run the cross-check.

## 17. Open items

- `GET /v1/time` with server UTC, current DUT1 and the leap table, for client clock sync (NTP-style min-RTT exchange over
  HTTPS) — the device clock is now the largest input error for a real-time client. Natural host: a Durable Object that
  refreshes IERS data by alarm (§12.1).
- Confirm on a real account: ingest wall time and success for the 102 MB streamed put (exercised here only against a
  fake R2 and the local file), and L2/L3 latencies from `diagnostics.cache` across a few colos.
- Terrain-aware horizon in `/v1/day` and `/v1/alignment` (GLO-30 profile along the azimuth, as in
  `reference/terrain_sunset/terrain_sunset.py`); a per-request refraction coefficient.
- True lunar node / libration exposure (DE440 tabulates librations: body 12).
- Claim or recreate the temporary deployment; add a scheduled cross-check against production.
- Browser build of `@ephem/core` for offline clients (one 8 KB block covers 32 days; a year is 91 KiB).

## 18. Provenance

This repository grew out of a natal-chart engine ("natal") built on the same DE440 reader. Kept from that work:
`packages/core/src/block.ts` (the evaluator, first verified in commit `7eae4c9`), and `reference/terrain_sunset/` — a
deterministic oracle for "when does the Sun's lower limb touch the terrain horizon" with a ray-traced atmosphere,
Copernicus GLO-30 terrain and golden vectors (`golden.json`), which remains the model for terrain-aware events. The
DE440 block layout was taken from ivarvong/de440 (Elixir), whose reader is the reference port for `block.ts`.
`examples/orrery.html` is an earlier standalone browser demo that embeds one block and renders Earth–Moon–Sun in WebGL;
its frame code predates `@ephem/core` (IAU 1976 precession) and is kept as an illustration of in-browser evaluation.

## 19. Sources

- JPL SSD, DE440: `https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/` (binary, `testpo.440`); Park et al. 2021, AJ 161:105.
- Capitaine, Wallace & Chapront 2003, A&A 412, 567 (P03 precession); Capitaine, Wallace & McCarthy 2003, A&A 406, 1135 (GMST, equation of the equinoxes).
- IERS Conventions 2010, ch. 5; IERS Bulletin C (leap seconds), Bulletin A (DUT1).
- USNO Circular 179 (Kaplan 2005): TDB−TT, aberration.
- Bennett 1982, J. Navigation 35, 255 (refraction); Meeus, *Astronomical Algorithms* 2nd ed. (bright limb 48.5).
- Vincenty 1975, Survey Review 23, 88; Karney 2013, J. Geodesy 87, 43 (GeographicLib, the reference).
- Skyfield 1.55 (Rhodes), the oracle's astronomy; pyproj 3.8 / PROJ, the oracle's geodesy.
- Cloudflare: R2 Workers API (range `get`, `put` with `sha256`), `FixedLengthStream`, Workers RPC (`WorkerEntrypoint`,
  service bindings, remote bindings in `wrangler dev`), Cache API.
