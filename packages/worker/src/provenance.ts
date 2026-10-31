// The provenance block every API response carries (docs/API.md): implementation, version and the sources the answer read.
export const VERSION = "0.1.0"
export const SOURCES = {
  de440: "JPL DE440 (linux_p1550p2650.440)",
  egm96: "EGM96 geoid (NGA WW15MGH, 15′ grid sampled at 30′)",
  wmm: "WMM2025 (NOAA NCEI)",
  metar: "aviationweather.gov METAR (metars.cache.csv.gz)",
} as const
export const PROV = { implementation: "@ephem/worker", version: VERSION, sources: [SOURCES.de440, SOURCES.egm96] }
/** Provenance for an answer that reads these sources. */
export const prov = (...sources: ReadonlyArray<string>) => ({
  implementation: PROV.implementation,
  version: VERSION,
  sources: [...sources],
})

/** A UTC instant parameter: the schema checked the shape; this checks it is a real date in the supported range. */
