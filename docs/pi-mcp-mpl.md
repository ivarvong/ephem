# Chart ephem data in pi

Give [pi](https://github.com/badlogic/pi-mono) the data source, the renderer's docs, and a question:

> Read https://ephem.ivar.workers.dev/llms.txt and the mpl docs at https://github.com/ivarvong/mpl. Use ephem's public MCP at https://ephem.ivar.workers.dev/mcp to plot sunset times for Tokyo for November 2026 in Asia/Tokyo. Save PNG and SVG, and read the PNG inline.

That's the composition: **ephem supplies the astronomy, mpl renders the chart, and pi writes the code just in time.** No application or prewritten integration required. mpl runs on Node 24+ without runtime dependencies.

ephem provides [agent-oriented instructions](https://ephem.ivar.workers.dev/llms.txt), [API docs](https://ephem.ivar.workers.dev/docs), and an [OpenAPI schema](https://ephem.ivar.workers.dev/openapi.json). Its public MCP needs no token; `tools/list` describes the live tools and inputs. Pi can read these sources, fetch the data, and choose the rendering calls from mpl's docs. Instructions worth remembering can become local pi skills; the task-specific code stays disposable.

[See the resulting Tokyo sunset chart.](https://github.com/ivarvong/ephem/pull/1)

For this example, central Tokyo is 35.6762° N, 139.6503° E. With a sea-level observer, standard sea horizon, upper solar limb, and modeled refraction at 10 °C / 1010 hPa, sunset moves from **16:46:35 JST on November 1** to **16:28:19 JST on November 30**. These are JPL DE440 predictions, not observed visibility.

Ask pi to retain the exact query, UTC event times, returned conventions, and `x-ephem-version` alongside the chart. Format times in the requested IANA zone and preserve missing events as gaps rather than inventing values.
