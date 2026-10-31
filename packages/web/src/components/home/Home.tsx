// The homepage's body: header, the sky chart, the countdown, the timeline, the readouts and the details below. The server
// renders the whole first frame from its own answers (the header at once, the rest when the answers are in: src/server/
// home.tsx), so the sky, the numbers and the timeline are on screen with no script; the browser hydrates the same DOM
// (seeded from the same answers at the same instant: src/client/home/frame.ts) and keeps it live. Values that change every
// second are signals bound straight to text nodes and attributes: a component re-renders only when its shape changes.
import { computed } from "@preact/signals"
import type { ComponentChildren } from "preact"
import { useLayoutEffect, useRef } from "preact/hooks"
import {
  curl,
  guideText,
  pointing,
  rawOpen,
  recenterShown,
  scrub,
  scrubbable,
  locNote,
  wxErr,
} from "../../client/home/state.ts"
import {
  DETAIL_LABELS,
  clockText,
  dayTitle,
  detailValues,
  eventRows,
  field,
  hasCompass,
  hasDetails,
  hasReadouts,
  liveClass,
  liveText,
  nextKind,
  nextName,
  nextTime,
  nextTomorrow,
  phaseText,
  skewHidden,
  skewText,
  skewTitle,
  tminus,
  wxAgeClass,
  wxAgeText,
  wxView,
} from "./derive.ts"
import { diagLines, footer } from "./diag.ts"
import { Timeline } from "./Timeline.tsx"
import { SkyChart } from "./SkyChart.tsx"
import { useActions } from "./actions.ts"

const city = computed(() => curl.value.city)
const cityClass = computed(() => (/^[0-9.]+° [NS], [0-9.]+° [EW]$/.test(curl.value.city) ? "coords" : undefined))
const curlText = computed(() => curl.value.text)
export const Header = () => (
  <header class="hd gut" id="top">
    <span class="brand">EPHEM</span>
    <h1 id="place" class={cityClass}>
      {city}
    </h1>
    <span class="skew" id="skew" hidden={skewHidden} title={skewTitle}>
      {skewText}
    </span>
    <span class="clock" id="clock" aria-label="Local time">
      {clockText}
    </span>
    <i class={liveClass} id="live" role="status"></i>
    <span class="sr-only" id="liveT">
      {liveText}
    </span>
  </header>
)

const golive = computed(() => scrub.value == null)
const recenterHidden = computed(() => !recenterShown.value)
const pointPressed = computed(() => (pointing.value === "on" ? "true" : "false"))
const pointHidden = computed(() => pointing.value === "hidden")
const PointIcon = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 18 18"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    aria-hidden="true"
  >
    <circle cx="9" cy="9" r="5.5" />
    <path d="M9 1v3.5M9 13.5V17M1 9h3.5M13.5 9H17" />
  </svg>
)
const Sky = () => {
  const a = useActions(),
    sec = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    if (sec.current) a.mountSky(sec.current)
  }, [])
  return (
    <section
      class="sky"
      id="sky"
      ref={sec}
      aria-label="Where the Sun and the Moon are: the whole sky, above and below the horizon"
    >
      <SkyChart />
      <div class="ctl" id="ctl">
        <button
          type="button"
          class="golive"
          id="golive"
          hidden={golive}
          aria-label="Back to now: the live sky"
          onClick={a.goLive}
        >
          Back to now
        </button>
        <button type="button" class="recenter" id="recenter" hidden={recenterHidden} onClick={a.recenter}>
          Recenter
        </button>
        <button
          type="button"
          id="point"
          aria-pressed={pointPressed}
          aria-label="Point your phone at the sky"
          title="Point your phone"
          hidden={pointHidden}
          onClick={a.point}
        >
          <PointIcon />
        </button>
      </div>
    </section>
  )
}

const guideHidden = computed(() => guideText.value == null)
const guideClass = computed(() => (guideText.value?.sim ? "guide sim" : "guide"))
const guideLabel = computed(() => guideText.value?.label ?? undefined)
const guideBody = computed(() => guideText.value?.text || "\u00a0") // never an empty text node: the server and the browser render the same nodes
const phase = computed(() => phaseText.value ?? "\u00a0")
const Next = () => {
  const k = nextKind.value
  return (
    <div class="ev cap" id="next">
      {k === "none" ? (
        "\u00a0"
      ) : k === "text" ? (
        nextName
      ) : (
        <>
          {nextName}
          <span class="tn">{nextTime}</span>
          {nextTomorrow.value ? <>{nextTomorrow}</> : null}
        </>
      )}
    </div>
  )
}
const Countdown = () => (
  <div class="cdh gut" id="bottom" aria-live="off">
    <div class="t" id="tminus">
      {tminus}
    </div>
    <Next />
    <div class="ph cap" id="phase">
      {phase}
    </div>
    <p class={guideClass} id="guide" aria-live="polite" hidden={guideHidden} aria-label={guideLabel}>
      {guideBody}
    </p>
  </div>
)

const Sec = ({ body }: { readonly body: "sun" | "moon" }) => {
  const c = hasCompass.value,
    parts: Array<readonly [string, ReturnType<typeof field>]> = []
  if (c) parts.push(["Compass", field(body, "compass")])
  parts.push(["Rise", field(body, "rise")], ["Set", field(body, "set")])
  if (body === "moon") parts.push(["Lit", field(body, "lit")])
  return (
    <div class="sec cap">
      {parts.map(([k, v], i) => (
        <>
          {(i ? " · " : "") + k + " "}
          <b>{v}</b>
        </>
      ))}
    </div>
  )
}
const Card = ({ body, name }: { readonly body: "sun" | "moon"; readonly name: string }) => {
  const k = body === "sun" ? "s" : "m"
  return (
    <section class="bd" aria-label={name}>
      <div class="ro">
        <div class="cap">
          <i class={k}></i>
          {name + " · Altitude"}
        </div>
        <div class="v" elementtiming={body === "sun" ? "ephem-data" : undefined}>
          {field(body, "alt", "°")}
        </div>
      </div>
      <div class="ro">
        <div class="cap">
          <i class={k}></i>Azimuth
        </div>
        <div class="v">{field(body, "az", "°")}</div>
      </div>
      <Sec body={body} />
    </section>
  )
}
const Readouts = () => (
  <div class="tel gut" id="bodies" aria-label="Sun and Moon readouts">
    {hasReadouts.value ? (
      <>
        <Card body="sun" name="Sun" />
        <Card body="moon" name="Moon" />
      </>
    ) : null}
  </div>
)

const Details = () => (
  <details class="disc" id="details">
    <summary>Details</summary>
    <div id="detailsBody">
      {hasDetails.value ? (
        <dl class="kv">
          {DETAIL_LABELS.map((k, i) => (
            <>
              <dt>{k}</dt>
              <dd>{detailValues[i]}</dd>
            </>
          ))}
        </dl>
      ) : null}
    </div>
  </details>
)
const Events = () => {
  const rows = eventRows.value
  return (
    <details class="disc" id="evmore">
      <summary id="dayTitle">{dayTitle}</summary>
      <div class="evs" id="evs">
        {rows == null ? null : rows.length ? (
          rows.map((e) => (
            <div class={e.past ? "past" : ""}>
              <span class={e.body === "sun" ? "s" : "m"}>{e.name}</span>
              <span class="tn">{e.time}</span>
            </div>
          ))
        ) : (
          <div>No events today.</div>
        )}
      </div>
    </details>
  )
}

const Num = ({ x, d, u }: { readonly x: number | null; readonly d: number; readonly u: string }) =>
  x == null ? (
    <>—</>
  ) : (
    <>
      {x.toFixed(d)}
      <span class="u">{u}</span>
    </>
  )
const Cell = ({ k, children }: { readonly k: string; readonly children: ComponentChildren }) => (
  <div>
    <div class="cap">{k}</div>
    <div class="v">{children}</div>
  </div>
)
const Weather = () => {
  const a = useActions(),
    v = wxView.value,
    err = wxErr.value
  let body: ComponentChildren
  if (err && !v) body = <span class="err">Weather unavailable: {err}</span>
  else if (!v) body = <span class="note">Finding the nearest station…</span>
  else if (v.none) body = <span class="note">No station reported.</span>
  else {
    const s = v.s,
      wd = v.wind
    const wind =
      wd.speedKt == null ? (
        "—"
      ) : wd.calm ? (
        "Calm"
      ) : (
        <>
          {wd.variable || wd.directionDegTrue == null ? (
            "VRB"
          ) : (
            <>
              {Math.round(((wd.directionDegTrue % 360) + 360) % 360)}
              <span class="u">°</span>
            </>
          )}{" "}
          {wd.speedKt}
          <span class="u">KT{wd.gustKt ? " G" + wd.gustKt : ""}</span>
        </>
      )
    const vis =
      s.visibility.statuteMiles == null ? (
        "—"
      ) : (
        <>
          {s.visibility.statuteMiles}
          {s.visibility.orMore ? "+" : ""}
          <span class="u">MI</span>
        </>
      )
    body = (
      <>
        <div class="wx">
          <div class="temp ro">
            <div class="cap">Temperature</div>
            <div class="v">
              <Num x={s.temperatureC} d={1} u="°C" />
            </div>
          </div>
          <div class="cond">{v.condition}</div>
        </div>
        <div class="wxg">
          <Cell k="Wind">{wind}</Cell>
          <Cell k="Dew point">
            <Num x={s.dewpointC} d={1} u="°C" />
          </Cell>
          <Cell k="Pressure">
            {s.altimeterHpa != null ? (
              <Num x={s.altimeterHpa} d={0} u="HPA" />
            ) : (
              <Num x={s.altimeterInHg} d={2} u="INHG" />
            )}
          </Cell>
          <Cell k="Visibility">{vis}</Cell>
        </div>
        <p class="station">
          {v.station} ·{" "}
          <span class={wxAgeClass} id="wxage">
            {wxAgeText}
          </span>
        </p>
        <p class="sr-only">{v.windText}</p>
        <details
          class="disc"
          id="rawd"
          open={rawOpen.peek()}
          onToggle={(e) => a.rawToggle((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>Raw METAR</summary>
          <pre>
            {v.raws.map((r, i) => (
              <>
                {i ? "\n\n" : ""}
                <span class="c">{r.comment}</span>
                {"\n" + r.raw}
              </>
            ))}
          </pre>
        </details>
      </>
    )
  }
  return (
    <section class="blk" aria-live="polite">
      <h2 class="cap">Weather</h2>
      <div id="wx">{body}</div>
    </section>
  )
}

const Diag = () => {
  const lines = diagLines.value
  return (
    <pre id="diag">
      {lines == null ? (
        <span class="c">waiting for the first answer…</span>
      ) : (
        lines.map((l, i) => (
          <>
            {i ? "\n" : ""}
            {l.map((s) => (s.cls ? <span class={s.cls}>{s.t}</span> : s.t))}
          </>
        ))
      )}
    </pre>
  )
}
const Hood = () => {
  const a = useActions()
  return (
    <details class="disc hood" id="hood" onToggle={a.hoodToggle}>
      <summary>Under the hood</summary>
      <div class="in">
        <div>
          <h3 class="cap">It's an API</h3>
          <p>
            Apparent topocentric positions from JPL DE440, rise, set and twilight, Moon phase and landmark alignments,
            in TypeScript on Cloudflare Workers and cross-checked against Skyfield. These are calls this page made:
          </p>
          <pre id="curl">{curlText}</pre>
          <div class="row">
            <a class="btn" href="/docs">
              API reference
            </a>
            <a class="btn" href="/openapi.json">
              openapi.json
            </a>
            <a class="btn" href="/licenses/din.txt">
              Font licence (D-DIN, OFL)
            </a>
          </div>
        </div>
        <div>
          <h3 class="cap">Diagnostics</h3>
          <p>
            The first frame is computed on Cloudflare and streamed with the page. Then this browser runs the same
            @ephem/core code on the same 8 KiB Chebyshev blocks of DE440 (on the server: an isolate LRU, the Workers
            Cache, then a byte-range read of the 102 MB file in R2), once a second and as you drag the timeline.
          </p>
          <Diag />
        </div>
      </div>
    </details>
  )
}
const Footer = () => {
  const f = footer.value
  return (
    <footer class="tel2" id="foot">
      {f == null ? null : "err" in f ? (
        <span class="err">{f.err}</span>
      ) : (
        f.map(([k, v]) => (
          <span>
            <i>{k}</i>
            {v}
          </span>
        ))
      )}
    </footer>
  )
}

/** Everything below the header (the header is its own root: the server sends it before the answers are in). */
const LocNote = () => (
  <span class="note" id="locnote">
    {locNote.value || null}
  </span>
)
export const Home = () => {
  const a = useActions()
  return (
    <>
      <Sky />
      <Countdown />
      <Timeline scrubbable={scrubbable} />
      <Readouts />
      <main class="home-main gut">
        <Details />
        <Events />
        <Weather />
        <div class="row">
          <button class="btn" type="button" id="locate" onClick={a.locate}>
            Use my exact location
          </button>
          <button class="btn" type="button" id="share" onClick={a.share}>
            Copy link
          </button>
          <LocNote />
        </div>
        <Hood />
        <Footer />
      </main>
    </>
  )
}
