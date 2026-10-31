// The mission timeline: today's events on one line (now − 3 h … now + 21 h), twilight as shading on the line, labels above
// (Sun) and below (Moon), past nodes filled, future hollow, the next event ringed, a NOW marker and, while scrubbed, the scrub
// cursor (lib/timeline.ts lays it out; src/client/home/strip.ts owns the model and the scrubbing). The markers move by
// signal-bound transforms; the rest redraws only when the layout changes (a new minute, data, a resize).
import { computed, type ReadonlySignal } from "@preact/signals"
import { useLayoutEffect, useRef } from "preact/hooks"
import { COLOR } from "../../lib/tokens.ts"
import type { TlPhase } from "../../lib/timeline.ts"
import { nowX, scrubX, strip } from "../../client/home/state.ts"
import { useActions } from "./actions.ts"

const SHADE: Readonly<Record<TlPhase, string>> = { day: "rgba(242,244,247,.75)", civil: "rgba(242,244,247,.42)", nautical: "rgba(242,244,247,.26)", astro: "rgba(242,244,247,.15)", night: "rgba(242,244,247,.07)" }
const BODY = { sun: COLOR.sun, moon: COLOR.moon } as const
const nowT = computed(() => (nowX.value == null ? undefined : "translate(" + nowX.value + ",0)"))
const nowShow = computed(() => (nowX.value == null ? "none" : undefined))   // the SVG display attribute, not a style (CSP)
const scrubT = computed(() => (scrubX.value == null ? undefined : "translate(" + scrubX.value + ",0)"))
const scrubShow = computed(() => (scrubX.value == null ? "none" : undefined))

const Layout = () => {
  const s = strip.value
  if (!s) return null
  const L = s.L, k = s.k, mk = L.mark
  return <>
    {L.segs.map(sg => <rect x={sg.x0} y={L.mid - 1.5} width={Math.max(0.5, sg.x1 - sg.x0)} height={3} fill={SHADE[sg.kind]} />)}
    {L.leaders.map(ld => <line x1={ld[0]} y1={ld[1]} x2={ld[2]} y2={ld[3]} stroke="rgba(242,244,247,.2)" />)}
    {L.nodes.map(n => {
      const col = BODY[n.body], other = n.bodies.find(b => b !== n.bodies[0])
      return <>
        {n.next ? <circle cx={n.x} cy={L.mid} r={7} fill="none" stroke={COLOR.accent} stroke-width={1.25} /> : null}
        {other ? <>   {/* a merged node of both bodies: half amber, half silver */}
          <path d={"M" + n.x + "," + (L.mid - 4) + "a4,4 0 0 0 0,8z"} fill={col} />
          <path d={"M" + n.x + "," + (L.mid - 4) + "a4,4 0 0 1 0,8z"} fill={BODY[other]} />
        </> : <circle cx={n.x} cy={L.mid} r={3.5} fill={n.past ? col : COLOR.bg} stroke={col} stroke-width={1.5} />}
      </>
    })}
    {L.labels.map(lb => {
      const cx = lb.x + lb.w / 2, c1 = lb.next ? COLOR.accent : lb.past ? COLOR.faint : COLOR.muted, c2 = lb.next ? COLOR.accent : lb.past ? COLOR.faint : COLOR.ink
      return <>
        <text x={cx} y={lb.y + 10 * k} text-anchor="middle" font-size={9.5 * k} letter-spacing="1.2" fill={c1}>{lb.name}</text>
        <text x={cx} y={lb.y + 24 * k} text-anchor="middle" font-size={12 * k} letter-spacing="0.4" fill={c2}>{lb.time}</text>
      </>
    })}
    {/* NOW: a cyan bar across the line, cut out of whatever is under it by a page-coloured edge; both markers end inside the gap */}
    <g transform={nowT} display={nowShow}>
      <line x1={0} x2={0} y1={L.mid - mk} y2={L.mid + mk} stroke={COLOR.bg} stroke-width={5} />
      <line x1={0} x2={0} y1={L.mid - mk + 1} y2={L.mid + mk - 1} stroke={COLOR.accent} stroke-width={2.5} /><title>Now</title>
    </g>
    {/* the scrub cursor: where the sky is while the timeline is dragged (hidden when live) */}
    <g pointer-events="none" transform={scrubT} display={scrubShow}>
      <line x1={0} x2={0} y1={L.mid - mk} y2={L.mid + mk} stroke={COLOR.bg} stroke-width={5} />
      <line x1={0} x2={0} y1={L.mid - mk + 1} y2={L.mid + mk - 1} stroke={COLOR.caution} stroke-width={2.5} />
    </g>
  </>
}

const viewBox = computed(() => { const s = strip.value; return s ? "0 0 " + s.w + " " + s.L.h : undefined })
export const Timeline = ({ scrubbable }: { readonly scrubbable: ReadonlySignal<boolean> }) => {
  const a = useActions(), ref = useRef<SVGSVGElement>(null)
  useLayoutEffect(() => { a.mountStrip(ref.current) }, [])
  const on = scrubbable.value
  return (
    <section class={on ? "tl gut scrub" : "tl gut"} id="tlbox" aria-label="Today's events">
      <svg id="tl" ref={ref} role="img" viewBox={viewBox} tabindex={on ? 0 : undefined}
        aria-label={on ? "Today's events on a timeline. Drag, or use the arrow keys, to move the sky through the day; Escape returns to live." : "Today's events on a timeline"}
        onPointerDown={a.stripDown} onPointerMove={a.stripMove} onPointerUp={a.stripEnd} onPointerCancel={a.stripCancel} onKeyDown={a.stripKey}>
        <Layout />
      </svg>
    </section>
  )
}
