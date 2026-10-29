# Terrain sunset contact — reference implementation

Executable form of the spec *Terrain Sunset Contact — Math Spec*. Computes when the Sun's lower limb
appears to touch the terrain horizon for an elevated observer.

    ./fetch_inputs.sh                 # DE440s + 4 Copernicus GLO-30 tiles, SHA-256 verified (~190 MB)
    pip install -r requirements.txt
    python3 terrain_sunset.py > out.json && diff <(jq -S . golden.json) <(jq -S . out.json)

`golden.json` is the contract: an independent implementation must reproduce its `cases` within the
tolerances in the spec (§9). Runtime ≈ 55 s (pure-Python RK4).
