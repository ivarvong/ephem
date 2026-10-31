// The sky chart, as SVG: all 360° of azimuth by the whole altitude range (lib/chart.ts skyModel, laid out by
// client/home/model.ts chartFrame). The sky at its real colour, the horizon, each body's track (one revolution around now,
// past solid ~70 %, future ~35 %, split at the live marker), the discs (the Moon with its phase; a disc within its glow of
// an edge also at the opposite edge) and one label per body, clear of every track, disc and button. The server renders it
// in the first frame (no script needed to see the sky); the browser hydrates it and re-renders it when its inputs change.
//
// Geometry is laid out for a size (skySize: the server's nominal phone or desktop frame, then the measured one) and drawn so
// that it stays right at any size until then: the sky, the ground and the tracks live in a layer stretched to the box
// (viewBox = the layout size, preserveAspectRatio none, strokes non-scaling); discs, labels, compass letters and the
// reticle are px-sized and anchored at percentages of the box. Laid out for the box it is drawn in, the two are the same.
import { computed } from "@preact/signals"
import { D2R, parallactic, wrap180 } from "../../lib/angles.ts"
import { CH_AXIS, chXs, chY, crBezier, GLOW, type Disc } from "../../lib/chart.ts"
import { isPlaced, type Placed } from "../../lib/labels.ts"
import { COLOR, DIN, skyAt } from "../../lib/tokens.ts"
import { altOf } from "../../lib/words.ts"
import type { Moon, Position } from "../../lib/types.ts"
import { chartRev, ctlRect, center, env, loc, now, pos, pose, skySize, track } from "../../client/home/state.ts"
import { chartFrame, wide, type ChartFrame } from "../../client/home/model.ts"
import { skyDescription, skyLabel } from "./derive.ts"

const BODY = { sun: COLOR.sun, moon: COLOR.moon } as const
const pc = (v: number, of: number) => (of ? ((100 * v) / of).toFixed(4) : "0") + "%"
const f2 = (v: number) => Math.round(v * 100) / 100

/** The frame the chart shows now (recomputed when any input changes; the canvas used to redraw on the same triggers). */
export const frame = computed((): ChartFrame & { readonly W: number; readonly H: number } => {
  void chartRev.value
  const z = skySize.value
  return {
    ...chartFrame({
      W: z.W,
      H: z.H,
      insetL: z.insetL,
      insetR: z.insetR,
      center: center.value,
      t: now.value,
      frozen: env.at != null,
      ctl: ctlRect.value,
      p: pos.value,
      rows: track.value,
    }),
    W: z.W,
    H: z.H,
  }
})

const trackPath = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>, a: number, b: number) => {
  let d = "M" + f2(xs[a]!) + "," + f2(ys[a]!)
  for (let j = a; j < b; j++) {
    const c = crBezier(xs, ys, j)
    d += "C" + f2(c[0]) + "," + f2(c[1]) + " " + f2(c[2]) + "," + f2(c[3]) + " " + f2(xs[j + 1]!) + "," + f2(ys[j + 1]!)
  }
  return d
}

const Sun = ({ r, alt }: { readonly r: number; readonly alt: number }) => (
  <>
    <circle r={r * GLOW.sun} fill="url(#ephem-sun-glow)" />
    <circle r={r} fill={alt > 6 ? "#fff3d6" : "#ffc46b"} />
  </>
)
const MoonDisc = ({ r, m }: { readonly r: number; readonly m: Moon }) => {
  const k = m.phase.illuminatedFraction
  const chi = (m.phase.brightLimbAngle - parallactic(altOf(m), m.azimuth, m.declination, loc.value.lat)) * D2R // bright limb from the zenith, toward east
  const rot = Math.atan2(-Math.cos(chi), -Math.sin(chi)) / D2R,
    rx = Math.max(0.01, r * Math.abs(1 - 2 * k))
  return (
    <>
      <circle r={r * GLOW.moon} fill="url(#ephem-moon-glow)" />
      <g transform={"rotate(" + f2(rot) + ")"}>
        <circle r={r} fill="rgba(60,70,100,.75)" />
        <path
          d={
            "M0," +
            -r +
            "A" +
            r +
            "," +
            r +
            " 0 0 1 0," +
            r +
            "A" +
            f2(rx) +
            "," +
            r +
            " 0 0 " +
            (k < 0.5 ? 0 : 1) +
            " 0," +
            -r +
            "Z"
          }
          fill="#eef2fb"
        />
      </g>
    </>
  )
}
const Marker = ({ d, p }: { readonly d: Disc; readonly p: Position }) => (
  <>
    {d.xs.map((x) => (
      <svg x={pc(x, frame.value.W)} y={pc(d.y, frame.value.H)} overflow="visible" opacity={d.below ? 0.5 : undefined}>
        {d.key === "sun" ? <Sun r={d.r} alt={altOf(p.sun)} /> : <MoonDisc r={d.r} m={p.moon} />}
      </svg>
    ))}
  </>
)
const Label = ({ l, W, H }: { readonly l: Placed; readonly W: number; readonly H: number }) => (
  <svg x={pc(l.x, W)} y={pc(l.y, H)} overflow="visible">
    <rect width={l.w} height={l.h} rx={3} fill="rgba(6,7,8,.6)" />
    <text
      x={5}
      y={f2(l.h / 2 + 0.5)}
      dominant-baseline="central"
      font-family={DIN}
      font-weight="700"
      font-size={wide(W) ? 12.5 : 10.5}
      letter-spacing="1.6"
      fill={l.id === "Sun" ? COLOR.sun : "#d7deeb"}
    >
      {l.id.toUpperCase()}
    </text>
  </svg>
)

export const SkyChart = () => {
  const f = frame.value,
    { m, W, H, p } = f,
    g = m.g,
    hy = g.hy,
    sc = skyAt(f.sunAlt),
    ps = pose.value
  const moonK = p ? p.moon.phase.illuminatedFraction : 0
  return (
    <svg
      class="chart"
      id="cv"
      width="100%"
      height="100%"
      role="img"
      tabindex={0}
      aria-label={skyLabel}
      aria-description={skyDescription}
    >
      <defs>
        <linearGradient id="ephem-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color={sc[0]} />
          <stop offset="1" stop-color={sc[1]} />
        </linearGradient>
        <radialGradient id="ephem-sun-glow" gradientUnits="userSpaceOnUse" cx="0" cy="0" r={5 * GLOW.sun}>
          <stop offset={0.6 / GLOW.sun} stop-color="rgba(255,214,140,.38)" />
          <stop offset="1" stop-color="rgba(255,214,140,0)" />
        </radialGradient>
        <radialGradient id="ephem-moon-glow" gradientUnits="userSpaceOnUse" cx="0" cy="0" r={6 * GLOW.moon}>
          <stop offset={1 / GLOW.moon} stop-color={"rgba(220,228,245," + f2(0.08 + 0.16 * moonK) + ")"} />
          <stop offset="1" stop-color="rgba(220,228,245,0)" />
        </radialGradient>
      </defs>
      {W ? (
        <>
          {/* (the glows: canvas-style radial gradients, flat inside the inner radius, as the stops' offsets) */}
          {/* the sky, the ground (the page itself: one surface) and the horizon, the one line; then the tracks */}
          <svg
            width="100%"
            height="100%"
            viewBox={"0 0 " + f2(W) + " " + f2(H)}
            preserveAspectRatio="none"
            overflow="hidden"
          >
            <rect width={f2(W)} height={f2(hy)} fill="url(#ephem-sky)" />
            <rect y={f2(hy)} width={f2(W)} height={f2(H - hy)} fill={COLOR.bg} />
            <path
              d={"M0," + (Math.round(hy) + 0.5) + "H" + f2(W)}
              stroke="rgba(242,244,247,.32)"
              stroke-width={1}
              vector-effect="non-scaling-stroke"
            />
            {(["sun", "moon"] as const).map((key) => {
              const tl = m.lines[key]
              if (!tl) return null
              return (
                [
                  [0, tl.split, 0.7],
                  [tl.split, tl.xs.length - 1, 0.35],
                ] as const
              ).map(([a, b, op]) =>
                b > a ? (
                  <path
                    d={trackPath(tl.xs, tl.ys, a, b)}
                    fill="none"
                    stroke={BODY[key]}
                    stroke-opacity={op}
                    stroke-width={1.25}
                    stroke-linejoin="round"
                    vector-effect="non-scaling-stroke"
                  />
                ) : null,
              )
            })}
          </svg>
          {/* N E S W, small caps, along the bottom */}
          {["N", "E", "S", "W"].flatMap((t, i) =>
            chXs(i * 90, g, f.c)
              .filter((x) => x > g.x0 + 8 && x < g.x1 - 8)
              .map((x) => (
                <text
                  x={pc(x, W)}
                  y={pc(g.bot + CH_AXIS / 2, H)}
                  text-anchor="middle"
                  dominant-baseline="central"
                  font-family={DIN}
                  font-weight="700"
                  font-size={wide(W) ? 12 : 10}
                  letter-spacing="1.6"
                  fill="rgba(242,244,247,.45)"
                >
                  {t}
                </text>
              )),
          )}
          {p ? m.discs.map((d) => <Marker d={d} p={p} />) : null}
          {/* pointing: the reticle, and a subtle arrow at the edge toward each body */}
          {m.pose && ps ? (
            <>
              <svg
                x={pc(m.pose.x, W)}
                y={pc(m.pose.y, H)}
                overflow="visible"
                stroke="#7dd3e8"
                stroke-width={1.25}
                fill="none"
              >
                <circle r={11} />
                {(
                  [
                    [0, -1],
                    [1, 0],
                    [0, 1],
                    [-1, 0],
                  ] as const
                ).map(([dx, dy]) => (
                  <path d={"M" + dx * 6 + "," + dy * 6 + "L" + dx * 15 + "," + dy * 15} />
                ))}
              </svg>
              {f.bodies.map((b) => {
                const d = wrap180(b.az - ps.az)
                if (Math.abs(d) < 3) return null
                const ax = d < 0 ? g.x0 + 6 : g.x1 - 6,
                  ay = Math.max(g.top + 8, Math.min(g.bot - 8, chY(b.alt, g))),
                  s = d < 0 ? 1 : -1
                return (
                  <svg x={pc(ax, W)} y={pc(ay, H)} overflow="visible">
                    <path d={"M0,0L" + s * 7 + ",-5L" + s * 7 + ",5Z"} fill={BODY[b.key]} fill-opacity={0.8} />
                  </svg>
                )
              })}
            </>
          ) : null}
          {f.placed.filter(isPlaced).map((l) => (
            <Label l={l} W={W} H={H} />
          ))}
        </>
      ) : null}
    </svg>
  )
}
