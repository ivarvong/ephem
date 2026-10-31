#!/usr/bin/env python3
"""Split Sofia Sans Condensed (the design system's subset, 271 code points, 33 KB) into the core the /instrument page uses
(printable ASCII + the few symbols its legends and help use: 18 KB woff2, inlined in the page) and the rest (served from
/assets with a unicode-range, so a browser downloads it only when a place name needs e.g. an accented letter).

    python3 scripts/instrument-fonts/sofia_core.py <SofiaSansCondensed-Legend.woff2> <out-core.woff2>

Prints one JSON line: {"core": "<unicode-range>", "rest": "<unicode-range>"}. All layout features (kern, case, liga, tnum)
and the wght axis are kept, so the core renders the same glyphs with the same spacing (fontTools pyftsubset).
"""
import json
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

CORE = [*range(0x20, 0x7F), 0xB0, 0x3C0, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026,
        0x2190, 0x2191, 0x2192, 0x2193, 0x2212, 0x221A]


def ranges(cps):
    cps, out, i = sorted(cps), [], 0
    while i < len(cps):
        j = i
        while j + 1 < len(cps) and cps[j + 1] == cps[j] + 1:
            j += 1
        out.append(f"U+{cps[i]:X}" if i == j else f"U+{cps[i]:X}-{cps[j]:X}")
        i = j + 1
    return ",".join(out)


def main(src, dst):
    have = set(TTFont(src).getBestCmap())
    core = [c for c in CORE if c in have]
    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.flavor = "woff2"
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    font = subset.load_font(src, opts)
    s = subset.Subsetter(opts)
    s.populate(unicodes=core)
    s.subset(font)
    subset.save_font(font, dst, opts)
    print(json.dumps({"core": ranges(core), "rest": ranges(have - set(core))}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
