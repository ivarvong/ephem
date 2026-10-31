// The parts of the API's answers (docs/API.md) the page reads. Answers arrive as JSON (embedded by the server, fetched, or
// computed in the browser by @ephem/core with the same shapes), so these are structural, not the contract itself.

export interface Body {
  readonly azimuth: number
  readonly altitude: number
  /** Refracted; null when the centre lies below the observer's horizon (API 2026-10-29). */
  readonly apparentAltitude: number | null
  readonly altitudeRate?: number
  readonly azimuthRate?: number
  readonly rightAscension?: number
  readonly declination: number
  readonly distanceKm: number
  readonly angularRadius?: number
  readonly eclipticLongitude?: number
  readonly eclipticLatitude?: number
}
export interface Phase {
  readonly name: string
  readonly illuminatedFraction: number
  readonly phaseAngle?: number
  readonly elongation?: number
  readonly brightLimbAngle: number
}
export interface Moon extends Body {
  readonly phase: Phase
  readonly brightLimbAngleFromVertical?: number
}

export interface CacheDiag {
  readonly l1: number
  readonly reads: number
  readonly [k: string]: number
}
export interface Provenance {
  readonly version?: string
  readonly sources?: ReadonlyArray<string>
  readonly diagnostics?: { readonly blocks: ReadonlyArray<number>; readonly cache: CacheDiag }
}
export interface Conventions {
  readonly refraction: { readonly temperatureC: number; readonly pressureHpa: number }
  readonly horizon: { readonly altitude: number }
}
export interface Observer {
  readonly lat: number
  readonly lon: number
  readonly heightEllipsoid?: number
  readonly magneticDeclination?: number
}

export interface Position {
  readonly time: { readonly utc: string }
  readonly sun: Body
  readonly moon: Moon
  readonly observer?: Observer
  readonly conventions?: Conventions
  readonly provenance?: Provenance
}

export interface TrackSeries {
  readonly azimuth: ReadonlyArray<number>
  readonly altitude: ReadonlyArray<number>
  readonly apparentAltitude: ReadonlyArray<number | null>
}
export interface Track {
  readonly start: string
  readonly stepSeconds: number
  readonly count: number
  readonly sun: TrackSeries
  readonly moon: TrackSeries
  readonly provenance?: Provenance
  /** The UTC day this window was built for (browser compute only). */
  readonly D?: number
}

export type BodyKey = "sun" | "moon"
export interface DayEvent {
  readonly body: BodyKey
  readonly kind: string
  readonly time: string
}
export interface Day {
  readonly date: string
  readonly start: string
  readonly end: string
  readonly events: ReadonlyArray<DayEvent>
  readonly provenance?: Provenance
}

export interface Wind {
  readonly speedKt: number | null
  readonly calm?: boolean
  readonly variable?: boolean
  readonly directionDegTrue: number | null
  readonly gustKt?: number | null
}
export interface SkyLayer {
  readonly cover: string
  readonly baseFtAgl: number | null
}
export interface Station {
  readonly stationId: string
  readonly distanceKm: number
  readonly bearing: { readonly true: number }
  readonly observationTime: string
  readonly observationAgeSeconds: number
  readonly raw: string
  readonly wx?: string | null
  readonly sky: ReadonlyArray<SkyLayer>
  readonly verticalVisibilityFt?: number | null
  readonly wind: Wind
  readonly temperatureC: number | null
  readonly dewpointC: number | null
  readonly altimeterHpa: number | null
  readonly altimeterInHg: number | null
  readonly visibility: { readonly statuteMiles: number | null; readonly orMore?: boolean }
}
export interface Weather {
  readonly observer: { readonly magneticDeclination: number }
  readonly feed: {
    readonly ageSeconds: number
    readonly stale?: boolean
    readonly tier: string
    readonly upstreamAgeSeconds: number | null
    readonly stations: number
  }
  readonly stations: ReadonlyArray<Station>
}
export interface Magnetic {
  readonly magnetic: { readonly declination: number }
}

/** Where the page computes for (the server's choice: query, Cloudflare geolocation, or the default). */
export interface Visitor {
  readonly lat: number
  readonly lon: number
  readonly place: string
  readonly city: string
  readonly tz: string
  readonly colo: string | null
  readonly source: "query" | "cloudflare" | "default"
}
