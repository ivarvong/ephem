#!/usr/bin/env bash
# Fetch the pinned geoid inputs and verify SHA-256 (fails loudly on mismatch).
#  - NGA's official EGM96 15′ interpolation package (WW15MGH.GRD, INTPT.F, INPUT.DAT/OUTINTPT.DAT test points)
#  - PROJ's GeoTIFF of the same NGA grid (cdn.proj.org), which the Skyfield oracle reads through pyproj
set -euo pipefail
cd "$(dirname "$0")/inputs"
[ -f egm96-nga.zip ] || curl -fsSL -o egm96-nga.zip "https://earth-info.nga.mil/php/download.php?file=egm-96interpolation"
[ -f us_nga_egm96_15.tif ] || curl -fsSL -o us_nga_egm96_15.tif https://cdn.proj.org/us_nga_egm96_15.tif
shasum -a 256 -c ../inputs.sha256
unzip -o -q egm96-nga.zip WW15MGH.GRD input.dat outintpt.dat readme.txt intpt.f
