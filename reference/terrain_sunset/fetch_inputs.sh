#!/usr/bin/env bash
# Fetch the pinned inputs and verify SHA-256. Fails loudly on any mismatch.
set -euo pipefail
cd "$(dirname "$0")/inputs"
fetch() { [ -f "$2" ] || curl -fsS -o "$2" "$1"; }
fetch https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440s.bsp de440s.bsp
for t in N40_00_W074_00 N40_00_W075_00 N40_00_W076_00 N40_00_W077_00; do
  f="Copernicus_DSM_COG_10_${t}_DEM.tif"
  fetch "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_${t}_DEM/$f" "$f"
done
sha256sum -c ../inputs.sha256
