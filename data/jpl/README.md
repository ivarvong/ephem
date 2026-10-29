# JPL DE440 test fixtures

- `testpo_sample.json` — 92 rows sampled from JPL's `testpo.440` (1850–2150; planets, Earth/Moon/EMB/SSB, nutations, librations).
- `blocks/<i>.bin` — the 8,144-byte DE440 blocks those rows need, range-read from
  `https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440` at `bytes=(2+i)*8144..(3+i)*8144-1`.

Regenerate: `python3 scripts/fetch-testpo-fixtures.py` (to be added). Blocks are git-ignored; CI fetches them.
