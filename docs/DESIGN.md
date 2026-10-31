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
| `@ephem/worker` | `handlers` (decode → block set → load → core → diagnostics) · `blocks` (cache tiers) · `router` (shared API router, CORS, explained 400s) · `app` (front door: + home, `/docs`, MCP) · `ingest` + `admin` (JPL → R2 RPC) · `index` (ephem entry) · `compute` (the Api + BlockStore entrypoints, §12.0) · `dev` (Node server) · `ops/` (local-only RPC caller) | core, api, effect |

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
`reference/geoid/inputs.sha256`) is subsampled to 30′ (361 × 720 nodes), rounded to 1 cm, and cut into 46 bands of 8 rows,
each planar-predictor residuals as zigzag varints (`egm96-grid.ts`, base64 in the source tree: 384 KB). **Since 2026-10-30 the
grid is not in the Worker bundle:** the bands live in R2 (`ephem-geoid`, one sha-addressed 288 KB object, uploaded by
`scripts/geoid-r2.ts`), the bundle carries only the manifest (`egm96-bands.ts`: offset, length, sha256 prefix per band), and
the handler prefetches the 1–2 bands of the observer's latitude through BlockStore (`/geoid/v<CACHE_VERSION>/<sha16>/<band>`,
Workers Caching, immutable) concurrently with the DE440 blocks, into an isolate L1 (`src/geoid.ts`). Bands are sha-checked at
BlockStore and again before use; any failure is a 503 `GeoidUnavailable`, never a guessed height. Core's `geoidUndulation`
reads an injected band source (`setGeoidSource`); tests and the dev server inject the source-tree grid. Same decoder, same
bytes: answers bit-identical (golden test; 8.28 M-lookup sweep). A lookup decodes only the ≤ 2 bands it touches, once per
isolate. Bilinear between nodes. Interpolation error against bilinear on the full 15′ grid (2 M area-uniform points):
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

**Rates.** `altitudeRate`, `azimuthRate` (°/min) in /v1/position, /v1/alignment (per point) and /v1/crossing:
analytic, one function (`topocentricRates`, observe.ts). d/dt of w = C·a in ITRS: Ċ·a = −Ω × w (Ω = dGAST/dt), and
ȧ = the DE440 Chebyshev velocity of the body at t − lt minus the observer's barycentric velocity, with the light-time rate,
the first-order change of aberration (including the diurnal centripetal acceleration) and aberration's 1/(1 + v̂·V/c) scale.
Left out: precession/nutation rates and the annual aberration change (each ≲ 1e-7 °/min). Measured against a Richardson
(30 s, 60 s) difference of the API's own positions over 200 000 random (time, place) samples: ≤ 3.6e-7 °/min altitude,
≤ 3.9e-7 °/min azimuth·cos(alt) away from the cusps, a floor set by the 40 µs rounding of a JD double, not by the rate. The ±10 s
symmetric difference it replaced (until 2026-10-30) was off by up to 2.3e-5 °/min within 10° of the nadir and failed
properties.test.ts about 1 run in 20. Near the zenith and nadir altitude has a cusp and azimuth spins, so both rates are
only meaningful a degree or more away from them. Against Skyfield's `frame_latlon_and_rates`: ≤ 1.2e-6 °/min altitude,
≤ 3.2e-6 °/min azimuth (was 1.5e-6 / 1.2e-5). It also costs less: no extra positions (position() 18.5 → 12.8 µs local).

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
point (analytic, as /v1/position); `target` echoes the target's heights; a `conventions` block states the solve, what
`azimuth` means, terrestrial refraction (modelled: constant k = 0.13 along the sight line), refraction and heights. The
Worker prefetches the geoid bands for target lat ± maxDistanceKm. Evidence: the Statue of Liberty reference repro
(2026-11-17T03:44:30–03:46:00Z) in ellipsoidal heights (their hand-copied N = −32.81 m) and in msl heights (70 m / 5 m)
agree to ≤ 8.5 m along a 12 m/s track (N at the statue is −32.90 m, so their target was 0.09 m high); vs the Skyfield
oracle with msl heights: position ≤ 25 mm, heightEllipsoid ≤ 1.8 mm (`crosscheck.py --only alignment`, 0 failures).

**Context (`include=sun,phase`, 2026-10-30).** On /v1/alignment (each track point and pass) and /v1/crossing (each
crossing): `sun` = the Sun's azimuth, true altitude and apparent altitude (sea horizon at the eye's height, else null) seen
from that point at that instant, and `phase` = the Moon's geocentric phase, both exactly /v1/position's values there
(worker test). Replaces the Liberty reference per-pass /v1/position calls. Answers without `include` are unchanged (no
CACHE_VERSION bump).

**Aim points (`aim`, `aim.ts`, 2026-10-30).** Which point of the disc is put on the target (alignment) or on the altitude
(crossing): `center` (default), `upper` / `lower` (the limb along the local vertical: the centre moved by the topocentric
angular radius asin(1737.4 km / topocentric distance), so diurnal parallax is in it), or `litCentroid`. Offsets are applied
to the direction vector in the true sky (exact rotation by ρ, not a small-angle az/alt sum), and the aim point's altitude is
then refracted; in the alignment solver the aim vector is rebuilt at every candidate point from the carried body (and Sun)
vectors, so the solve still has no ephemeris call in its inner loop. With `aim=center` the code path and answers are
bit-identical to before (golden unchanged).

*Lit-area centroid.* Orthographic disc of radius r, parallel sunlight, phase angle i (topocentric: angle Sun–Moon–eye). With
x towards the bright limb, the lit region is −cos i·√(r² − y²) ≤ x ≤ √(r² − y²): area (1 + cos i)πr²/2, first moment
(2/3)r³ sin² i, so **x̄ = (4r/3π)(1 − cos i)** (0 at full, 0.424 r at quarter, → 0.849 r for a thin crescent). Direction: the
Sun's direction from the Moon projected on the sky plane at the Moon; the projection of Sun − Moon equals the Sun's own
(Moon − eye is along the line of sight), so it is exact. Validation: `reference/oracle/litcentroid.py` (Skyfield + DE440s,
2 M equal-area points on the lunar sphere, visible ∧ sunlit, weighted by solid angle at the eye, centroid on the gnomonic
sky plane) at four instants (crescent 9 %, 46 %, 45 %, gibbous 82 %): offsets agree to ≤ 0.028′ (0.19 % of r, the
orthographic approximation), angles to ≤ 0.006° (`core/test/aim.test.ts`). **Reference check** (Nov 16 2026 EST, 47 %):
ours 6.844′ at 155.70° clockwise from the vertical (brute force 6.847′, 155.70°); their 6.75′ is exactly the closed form
with the *geocentric* illuminated fraction 46.9 % instead of the topocentric 46.15 % (parallax moves the phase angle ≈ 0.9°).
On the track, the spot where the centroid is on the statue at 03:45:19 gets the centre 36.8 s later, 4.5 m to the side
(reference: 40 s, 4.9 m). Crossing with litCentroid: the set moves by offset·cos(angle)/rate (test, ≤ 2 s).

*Bright limb from the vertical.* /v1/position `moon.brightLimbAngleFromVertical`: the same direction, degrees clockwise from
the local vertical as seen from the eye (towards increasing azimuth), topocentric. Checked against 360° − (χ − q), Meeus'
position angle from topocentric RA/Dec minus the parallactic angle, to < 0.01° (spherical trig vs vectors).

**Converse ("from here, when").** With `observerLat/Lon`: the azimuth to the target and its apparent elevation are fixed;
find the instants where the body's azimuth − target azimuth crosses zero (2-min sampling, ±180° wrap crossings
discarded), and report `altitudeOffset` = body apparent altitude − target elevation. Negative means the body centre is
below the target's top, i.e. behind it; compare with `angularRadius` for partial occultation.

**Sight line (`/v1/sightline`, `sightline.ts`, 2026-10-30).** For a fixed eye → target: the line's height above MSL
against ground distance, and clearance over obstacle points `lat:lon:heightMsl` (≤ 100). A separate endpoint rather than an
alignment parameter: it is time-independent pure geometry (no DE440 blocks, no window), so it caches as one immutable entry
per (eye, target, obstacles) instead of once per alignment window, and an alignment *track* has a different eye at every
instant (ask it for the spots you shortlist). Geometric line: the chord between exact WGS-84 ECEF points (curvature by
construction), each sample's geodetic height minus N at the foot; distance = geodesic to the foot. Refracted line: the ray
of curvature k/R (k = 0.13, as alignment) through both ends, k·s₁·s₂/(2R) above the chord (0.034 m mid-way over 3.6 km);
stated in conventions. Obstacles are projected on the line (along, cross-track: a local flat projection, so crossTrackM is
approximate at tens of km), clearance = line − obstacle, `blocks` = refracted clearance < 0. Evidence: PROJ (EPSG
4978→4979) + GeographicLib on a 3.6 km and a 152 km line: heightEllipsoid ≤ 1.5e-7 m, distance ≤ 2.6e-7 m; midpoint drop
= s₁s₂/2R to ±5 cm (N varies); Pier 6 → statue figure crosses Governors Island at ~28 m MSL (reference: 22–28 m).
### 10.x Alignment search over a region (`region.ts`, `search.ts`, `search-request.ts`; 2026-10-30)

`POST /v1/alignment/search` answers "every pass in [start, end) when the alignment standing point P(t) lies inside a
standing region", in one call. It replaces the Liberty reference crossing → alignment → polygon clip → position pipeline (~150
calls, ~39 s per 12-month scan). P(t) is `standingPoint` (above, same solver, heights, `aim`), so nothing new is modelled.

**Region.** GeoJSON Polygon / MultiPolygon with holes (or a Feature with one) or a bbox. Edges are straight in (lon, lat)
(RFC 7946 §3.1.1); inside = even-odd per polygon. Canonical form: coordinates quantised to 1e-7° (≤ 1.1 cm), closing and
repeated vertices dropped, rings re-oriented (right-hand rule) and started at their smallest vertex, holes and polygons
sorted; `r1.` + base64url of zigzag-delta varints (the 424-node park: 3.2 KB). Decoding re-canonicalises and must give
the same string, so a cache key names exactly one region. Clipping works in an affine image of (lon, lat), which keeps the
RFC 7946 lines straight, so insideness and crossings are exact; its metre scale is used only for tolerances. Bounds: ≤ 1 000
vertices, ≤ 100 rings, ≤ 50 km across, ≤ 100 km from the target, target outside the region and above the eye (the solver
brackets P assuming the target is above the eye: /v1/alignment has no standing point for a lower target).

**No representative elevation; complete by construction.** P inside ⇒ (a) the body's apparent altitude at P = the target's
apparent elevation from P ∈ [e(farthest), e(nearest)] (exact WGS-84 elevations at the region's nearest edge point and
farthest vertex; with the target above the eye elevation falls with distance) and (b) its azimuth ∈ the region's range of
bearings to the target (extremes at vertices). Seen from one reference point R (bbox centre) the body differs by at most the
tilt of the vertical s/R_min (R_min = 6 335 439 m), parallax s/356 400 km and meridian convergence; with `aim` ≠ center the
aim point is ≤ one disc radius (< 0.3°) off the centre. Those are the margins (park: altitude 0.0104°, azimuth 0.0184°).
The scan then uses two Lipschitz bounds at R (geodetic latitude φ). A fixed direction's altitude changes at ω·cos φ·sin A
(ω = 15.0411°/h) and its azimuth at ω·(sin φ − cos φ·cos A·tan h); the body's own motion seen from R adds < 1°/h of arc
(Moon ≤ 0.64°/h geocentric + 0.27°/h diurnal parallax), ÷ cos h in azimuth. So |dh/dt| ≤ ω·cos φ + 1°/h (12.4°/h at New York;
the earlier global 16°/h was ω + 1 at the equator), and while |h| ≤ H, |dA/dt| ≤ ω·(|sin φ| + cos φ·tan H) + 1°/h ÷ cos H.
Where the altitude is d from the band no in-band instant lies within d/L, so the scan jumps that far; it also jumps on the
azimuth's distance from its band (H = band + 15°, and only as far as |h| provably stays ≤ H), which skips the risings and
settings at the wrong bearing. Near the band it steps 60 s and keeps each step [t₀, t₁] with d(t₀) + d(t₁) ≤ L·(t₁ − t₀) for
both altitude and azimuth (H = band + 1°). Each kept span's ends are then pulled in by the same jumps from both sides until a
jump is < 1 s, and an end is always an evaluated out-of-band instant. Every instant with P inside lies in a kept span, and span
ends are outside (counted as `anomalies` if ever not; 0 everywhere so far). Measured (2026-10-30, Node, the Liberty reference
12-month park scan): scan evaluations 16 649 → 6 210, track evaluations 4 376 → 2 563, span time 15 660 → 9 713 s, same
64 passes / 125 segments, entries and exits within 1 ms (ms rounding), brute force 1 s: 0 missed.

**Exact entries and exits.** Along a span P(t) is sampled with chords ≤ 50 m (from the measured speed), bisected where a
sample sits > 4 cm off its neighbours' chord (park: max 0.6 mm). For each chord that crosses an edge, the signed distance of
P(t) from the edge's line is solved with Illinois' method on the true track (each evaluation a full standing-point solve)
to 1 mm (≈ 0.1 ms at 12 m/s). Between consecutive crossings the state is even-odd inside/outside; segments < 1 ms are
dropped, touching ones merged. Segments < 1 h apart form a pass; a pass belongs to the window holding its first entry.

**Windows and caching** (Workers Caching stores GET/HEAD only, so a POST is never cached). The front door validates and
canonicalises the POST, then fans out one `GET /internal/alignment-search-window` per 30-day window on a fixed UTC grid
(multiples of 30 d since 1970-01-01), every parameter explicit, so equal searches share keys. Each window is immutable,
computed in its own Api invocation in parallel, scans 6 h before and 2 h after itself so passes on its edges are whole and
owned once (tested: splitting a range inside a pass gives the same passes). A rolling "next 12 months" scan a day later
shares 13 of 14 windows; filters (`minIlluminated`, `maxSunAltitude`) and `include=sun,phase` run after the cache. The
front door does no astronomy. Rejected alternative: a GET form of the whole search keyed by region hash, which only hits
on exact repeats and puts a whole year's CPU in one invocation.

**Evidence** (scratchpad `search/`, Node, DE440 local):

| Check | Result |
| --- | --- |
| Liberty reference scan: Liberty 40.68925, −74.04450, 70 m MSL; Brooklyn Bridge Park (OSM way 56469108, 424 refs); eye 5 m MSL; 2026-10-30 → 2027-10-30 | **64 passes, 125 segments** (reference: 64 / 125); 66 spans, 16 649 scan + 4 376 track + 559 refine solves, 164 ms Node |
| Nov 16 pass entry | **2026-11-17T03:45:19.646Z at 40.703292, −73.996305** (reference: 03:45:19 at 40.70329, −73.99630) |
| Brute force: solver every 1 s whenever the Moon is within [−1.5°, +3°] at the park centre (band 0.24–0.68°), no azimuth filter, 12 months | 1 165 039 solves, 1 047 in-park instants, **0 outside a returned segment**, all 125 segments sampled |
| Brute force on other geometries (`search.test.ts`, 30 days): Sun over a 2–9 km fan, 55° of bearings; Moon, 300 m tower 1–3 km away, MultiPolygon with a hole | 0 missed |
| Entries/exits on an edge, and P(entry time) = the entry point | ≤ 1 cm, ≤ 2 cm (ms rounding of the time) |
| aim=litCentroid, Nov 16 (47 % lit) | entry 36.3 s earlier (reference: 40 s; §10 aim: 36.8 s on the track) |

The remaining differences from the reference numbers are inputs, not geometry: they used one hand-copied N = −32.81 m for
both ends (EGM96 here: −32.90 m at the statue, −32.81 m at the park), 5 s sampling plus client-side bisection, and the same
OSM outline (piers and inlets split passes identically: 125 segments both ways).

## 11. The contract (`@ephem/api`)

`EphemApi = HttpApi.make("ephem").add(sky, meta)` with `GET /v1/position`, `GET /v1/day`, `GET /v1/alignment`,
`GET /v1/crossing`, `POST /v1/alignment/search` + `GET /internal/alignment-search-window` (§10.x), `GET /v1/track` (Sun/Moon azimuth, true and apparent altitude on a UTC grid, columnar; each sample equals
`/v1/position` at that instant; ≤ 8 days and ≤ 1 441 samples, step 60–3600 s, start/end on the step's grid), `GET /healthz`, plus `/openapi.json` generated from the same value, `/docs` (plain HTML, no JS: endpoints, parameters from `QUERY_PARAMS`, conventions from `CONVENTIONS`, links to the spec, `/llms.txt`, `/mcp` and `/docs/interactive`, the Scalar page; 2026-10-30) and `/llms.txt` (the same, as text for agents). Query parameters decode through
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

**Block loading** (`blocks.ts`), per block (8 144 B, the smallest unit DE440 has): an in-isolate LRU (512 blocks, 4.2 MB,
~45 years), then one fetch per missing block through the BlockStore loopback (`GET /block/v<CACHE_VERSION>/<sha16>/<i>`,
Workers Caching, `public, max-age=31536000, immutable`, cross-version; §12.0), whose MISS is one exact R2 range read. The
key carries the file hash, so a different ephemeris can never be served from an old entry. In-flight de-duplication per
block; failed loads are not memoised; the range length is checked on arrival, and each block's own JD header is checked
against its index before use, so an offset error can never be cached as truth (tested with a deliberately off-by-one
origin). A missing block is an infrastructure fault and becomes a 500 (`Effect.orDie`), not a typed client error.
(Until 2026-10-29 the second tier was the Cache API, `caches.default`; ephem uses Workers Caching only.)

**Deployment.** Every commit on main ships through `scripts/ship.sh` → `scripts/deploy.sh` (gate, 0% canary, telemetry
gate, promote, live gate, auto-rollback; docs/telemetry_and_profiling.md "Ship and roll back"); never `cf deploy` or
`wrangler deploy` by hand. The DE440 file is ingested once into R2 through the Admin entrypoint:

```
npx wrangler dev -c packages/worker/ops/wrangler.jsonc            # local caller, remote binding to ephem#Admin
curl localhost:8788/ingest                                        # JPL → R2, verified; ~102 MB, once
curl localhost:8788/status                                        # { present, sizeBytes, sha256, matchesPinned }
```

Until ingest has run, data endpoints return 500 with "R2 object … missing — run the ingest RPC". No `nodejs_compat`.

**Size.** The bundle was 4.3 MB raw / 1.1 MB gzip with `HttpApiScalar.layerCdn`, which inlines ~3.1 MB of Scalar
(73 % of the script). `/docs` is now a ~400-byte page that loads `@scalar/api-reference@1.74.0` from jsDelivr and points
it at `/openapi.json`; with `minify: true` the Worker is 516 KiB / 167 KiB gzip (Effect HttpApi + Schema + core), an
85 % cut. It then grew to 985 KiB / 451 KiB gzip (2026-10-30: the bundled EGM96 grid 384 KB, Effect 465 KB, home page 60 KB) and
was cut to **402 KiB / 139 KiB gzip** (git 0b88f9f): the geoid moved to R2 (§7.2), and every Effect import goes by module
subpath (`import * as Effect from "effect/Effect"`), because esbuild keeps the whole namespace of a barrel import
(`import { Schema } from "effect"`): Effect 465 → 228 KB. Startup effect, measured by version: fresh Api isolate pre-router
gap p50 117 → 99 ms, first-request CPU unchanged (lab notebook ephem-telemetry-history-2026-10-31.md, findings 2026-10-30).

**Local.** `node --experimental-strip-types packages/worker/src/dev.ts 8787` runs the identical handler on Node with
blocks range-read from a local copy of the DE440 file (`data/jpl/`) with the same `makeBlocks` and the same offsets
as R2; this is what the cross-check harness targets.

**The homepage computes in the browser after the server's first frame (2026-10-31; ivar: "Try it. But initial server render
too right").** `/` still streams the API's own answers for the first frame (src/embed.ts). The page then loads its core
module (@ephem/core's `position`, `track` and `day` from `packages/core/src/browser.ts`, bundled by Vite into a
content-hashed static asset, §12.3; no geoid code or manifest, WMM, search or alignment: `observerHeights` moved from
horizon.ts to geoid.ts for this), and the DE440 blocks it needs from `/assets/de440/<de440 sha16>/<i>` (the `Blocks`
service: isolate LRU → BlockStore → Workers Caching → R2; src/sky-assets.ts). Both are content-addressed and immutable and
are not part of `/v1`: they are the page's implementation, not a question anyone asks. The observer comes from the
embedded answer itself (lat, lon, ellipsoid height = the geoid N as a number, refraction temperature and pressure, horizon
altitude), so the browser needs no geoid. Before it takes over, the page recomputes the server's position (31 fields),
track (every sample) and day (every event) at the server's instant and inputs and requires agreement within 1e-9° /
1e-6 km / 1 ms; otherwise it stays on the API. The gate imports the built core module and runs it against the server path
on 4 000 + 300 + 300 random cases from 1900 to 2150 (packages/web/test/core-parity.test.ts; Node: bit-identical); headless
Chrome differs in the last bits only (scripts/obs/sky-parity-chrome.ts). JavaScriptCore (Safari) has not been run. The
page's clock is the server's (offset from Navigation Timing, ± half the request window).

### 12.3 The web UI: `packages/web` (2026-10-31; ivar: "we need a professional, modern web stack here dude. make this serious")

Until 2026-10-31 every page was HTML and `var`/global-function JS in TS template strings (home.ts 1 521 lines, docs.ts,
embed.ts): no types, modules, lint, tests or build for the client. Now:

```
packages/web (@ephem/web)                    packages/worker (the server)
  src/lib/         pure typed logic ◀──────── og.ts (ported, tested equal), home.ts (the first-load queries)
  src/components/  Preact TSX view ─┐
  src/client/      browser controller│ hydrate        src/home.ts  GET / ─▶ renderHomeHead (stream) + embeds ─▶ renderHomeTail
  src/server/      render + CSP ◀───┴────────────── src/app.ts   /docs, /docs/interactive ─▶ renderDocs / renderScalar
  src/styles/      Tailwind v4 @theme             wrangler.config.ts assetsDirectory = packages/web/dist/client
  dist/  (built, not committed) ─────────────────▶ Workers Static Assets: /assets/<name>-<hash>.{js,css,woff2}, immutable
```

- **Stack.** TypeScript strict, ES modules; Preact + @preact/signals in TSX; Tailwind CSS v4 with the design system as
  `@theme` tokens (colours, the Ephem DIN font, type scale, breakpoints; `lib/tokens.ts` carries the colours for canvas and
  SVG, tested equal); Vite builds the client (entries: `home`, the lazy `core`, the stylesheet, `scalar`). The Worker is
  still built by `cf`/wrangler (wrangler.config.ts runs the web build first and points `assetsDirectory` at its output):
  @cloudflare/vite-plugin would own the Worker build and its config, which is `cf`'s cloudflare.config.ts (exports with
  per-entrypoint caching, tail consumers, pipelines) and deploy.sh's versioned 0 % canary; so Vite builds only the client.
- **Rendering: the first frame is the server's, whole.** The Worker sends the head (the build's stylesheet inline, the module,
  the boot JSON) and the header at once; when its in-process answers are in (embed.ts: position, track, today, tomorrow,
  magnetic) it renders the entire first frame from them with preact-render-to-string: the sky chart (SVG: sky colour,
  tracks, discs with the Moon's phase, labels), the countdown, the timeline, the readouts, the details; then the answers
  as `<script type="application/json">`, then `</body>`. The sky and the numbers are on screen when the HTML is parsed, with
  the inline CSS and no script: data drawn is the browser's own Element Timing of the readouts (`ephem-data`), re-marked
  `ephem:data` at that instant by the module once it runs. The components read module-level signals; the server seeds them
  (client/home/frame.ts), renders synchronously and resets them, so requests in an isolate never share state. The
  deferred module seeds the same state from the same embedded answers at the server's instant and hydrates: nothing
  changes (test/hydrate.test.tsx: no node added, removed or rewritten, five sky states, phone and desktop frames); then it
  goes live (the corrected clock, the measured size, the takeover, weather). Text is laid out from Ephem DIN's own advances
  (lib/din-metrics.ts), not measured, so server and browser lay out alike, before and after the font arrives (it loads
  after boot: src/client/fonts.ts). The server cannot see the viewport: it lays the frame out for a phone (390 × 337.6,
  the 358 px timeline) or a desktop (1 440 × 504, 1 080 px) by the request's `Sec-CH-UA-Mobile` / user agent; the chart's
  sky, ground and tracks stretch with the box and its discs, labels and letters are anchored at percentages, so the frame
  is right at any size, exact at the nominal one; the browser measures and re-lays out (only labels can move, by a few px,
  off the nominal sizes). Preact's Suspense streaming is not used: it moves late content with an inline script.
- **The chart is SVG** (components/home/SkyChart.tsx; it was a canvas until the server rendered the first frame): one
  renderer for the server's frame and every live and scrubbed frame, re-rendered by Preact when its inputs change. Scrub
  at iPhone CPU 4×: see the guide "Homepage".
- **No inline executable JS.** Every page's CSP is `default-src 'none'; script-src 'self'` (no `'unsafe-inline'`, no
  nonces, no hashes for scripts); the homepage's one inline `<style>` is the built stylesheet, allowed by its sha256 (the
  build computes it). `/docs` runs no script at all; `/docs/interactive` loads Scalar from jsDelivr pinned by version and
  SRI, then our module configures it (Scalar injects its own styles: `style-src 'unsafe-inline'` on that page only). No
  `on*=` or `style=` attributes anywhere. Tests: packages/web/test/render.test.tsx, packages/worker/test/home.test.ts (every
  page as served); smoke `csp-*` checks the deployed pages.
- **Assets.** Content-hashed (`/assets/<name>-<hash>`), served by Workers Static Assets ahead of the Worker (no invocation),
  `public, max-age=31536000, immutable` from `_headers`. Fonts are self-hosted woff2 files (glyph pins the OG card's fonts by
  the sha256 the build records). `/assets/de440/…` is not a file, so it reaches the Worker. The old hand-rolled
  `/assets/<sha16>/ephem-sky.js` and the inline base64 font are gone.

### 12.0 One Worker: front door and cache-enabled entrypoints (decided by A/B, 2026-10-30)

```
eyeball ─▶ ephem default (cache OFF; always runs: traces, Basin row, request.cf)
             ├─ /, /docs, /llms.txt, /openapi.json, /mcp, /healthz, live position / magnetic, /v1/weather
             ├─ POST /v1/alignment/search: validate, fan out the window GETs, merge (no astronomy)
             └─ deterministic GET API and every search window ─▶ ctx.exports.Api (cache ON: cf.cacheKey = /v<CACHE_VERSION><path?sorted query>)
                    └─ blocks / geoid ─▶ ctx.exports.BlockStore (cache ON) ─▶ R2
           live routes' blocks / geoid ─▶ ctx.exports.BlockStore; weather ─▶ ctx.exports.MetarFeed (cache ON)
```

Api and BlockStore (src/compute.ts, the lean API router src/router.ts `makeApiHandler`) are cache-enabled entrypoints of
`ephem` itself, called through `src/loopback.ts` with CACHE_VERSION in every key; crossVersionCache is on. A loopback runs
the caller's version, so a pinned canary's forwarded MISSes run on the canary (`x-ephem-compute-version` = its own id;
scripts/smoke.sh `compute` check).

**Tried and removed: `ephem-compute`**, a separate Worker for Api + BlockStore behind service bindings (git 01e0323;
served 2026-10-30 19:44Z – 21:37Z). A pre-registered concurrent A/B (S = 02dd1270 + ephem-compute fca6e275 vs E = cc6ddd8e,
git 5edf1b7, 6 × 240 s) found S faster on cold scans (server e2e p50 −29 ms [−40, −20]) but **+30 ms CPU per scan
[+21, +40] (+3 %)**, so the rule chose one Worker (ephem d3caf38f, git 7a125fd); the gain was only measured at synthetic
contention and the second Worker cost something on every deploy. Full A/B: ~/code/lab_notebook/ephem-telemetry-history-2026-10-31.md
("Compute split"). Re-run at real load if search traffic ever approaches contention (commit 5edf1b7 holds both arms).

Found on the way (kept): core's EGM96 band source is a process global, and an isolate holds two `makeGeoid` (front door +
Api); src/geoid.ts now installs a source that reads every L1 (the E arm's first canary 500'd /v1/position?time= without it).

### 12.2 Trace context, Server-Timing and RUM (2026-10-30)

One trace id per page view, from the browser through every server entrypoint, for real users as well as the lab harness:

- **Documents** (`/`; `src/clienttrace.ts`): the front door adopts a valid incoming `traceparent` (W3C, strict:
  version 00, lower-case hex, non-zero ids) or uses the root request span's own trace id, and returns it three ways:
  `<meta name="traceparent" content="00-<trace>-<root span>-01">` (the OpenTelemetry document-load convention),
  `Server-Timing: trace;desc="…"` (the navigation entry's `serverTiming`) and `x-ephem-trace`. The HTML is `private,
  no-store` and never forwarded to the cached Api, so a per-response id cannot be replayed (tested).
- **Fetches**: the page reads meta → serverTiming → a fresh id, and every fetch sends a child `traceparent` plus
  `tracestate: ephem=<document span>`. Root spans record `client.trace_id`, `client.span_id`, `client.parent_id`
  (documents: `client.document_span_id`, `client.trace_origin` adopted|minted). Loopbacks carry it on: the Api gets the
  client's header, BlockStore and MetarFeed get the calling span's (`loopback.trace` span). A BlockStore fetch is shared
  by concurrent requests in an isolate (in-flight dedup), so it carries the trace of the request that started it.
- **Server-Timing** on every front-door response: `ray`, `api` (cache status + loopback duration), `api-blocks/geoid` (a
  fresh Api run only: a cached answer would replay another request's numbers), `blocks`, `geoid`, `feed`, `trace`, `total`.
  Durations are the Workers clock, which only moves on I/O. There is deliberately no CPU entry: CPU is not readable inside
  a request; it is `cpuTimeMs` in Workers Observability, joined by trace id or ray. `Timing-Allow-Origin: *`.
- **RUM** (`src/rum.ts`; the client is packages/web/src/client/rum.ts and trace.ts, in the page module) (navigation + resource timing with serverTiming, FCP, LCP,
  CLS, INP, long animation frames, every fetch with its ids, app spans) batched to `POST /rum` (uncached; ≤ 64 KiB, ≤ 300
  spans, per-trace and per-isolate limits), validated to route ids and fixed patterns, stored in Basin `ephem_rum` →
  `ephem.rum`. Request rows (`ephem.requests`) carry the trace ids. DNT/GPC and unsampled traceparents send and store nothing; synthetic traffic is flagged.
- Tools: `scripts/obs/journey.ts` (CDP lab instrument, checks RUM against Chrome's ground truth) and
  `scripts/obs/trace-view.ts <trace-id>` (a real view from RUM + server telemetry); guide: "Unified client+server traces".

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
weekly by alarm, which `/time` needs (§17). That is independent of the ephemeris path.

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
npm test                                                        # offline (the geodesic test needs pyproj)
npx oxlint packages scripts && npm run typecheck
curl -o data/jpl/linux_p1550p2650.440 https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440   # local dev only
python3 reference/oracle/server.py --port 8440                  # oracle (needs de440s.bsp: reference/terrain_sunset/fetch_inputs.sh)
node --experimental-strip-types packages/worker/src/dev.ts 8787
python3 reference/oracle/crosscheck.py --a http://127.0.0.1:8440 --b http://127.0.0.1:8787
git commit …                                                    # ship.sh deploys it; first time: ingest via ops/ (§12)
node --experimental-strip-types scripts/openapi.ts              # refresh reference/openapi.json after a contract change
```

A contract change is made in three places, in this order: `@ephem/api` (the value), `reference/oracle/server.py` (the
independent implementation), then core/worker; then regenerate fixtures and run the cross-check.

## 17. Open items

- **Target extent (open), designed, not built:** target = vertical segment base..top with half-width w
  perpendicular to the sight line → for a fixed observer an angular box az ∈ A ± atan(w/D), apparent elevation
  [e_base, e_top]; contact / clear = first / last instant the disc (aim point, radius r) is within r of the box. "Full overlap"
  needs a user's definition (disc inside the box is impossible for the Statue of Liberty, 0.14° wide vs a 0.5° disc;
  the box's width inside the disc at the target's height is the silhouette case). It belongs with /v1/alignment/search,
  where intervals are per standing segment, so it waits for that endpoint.

- `GET /time` with server UTC, current DUT1 and the leap table, for client clock sync (NTP-style min-RTT exchange over
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
