#!/usr/bin/env python3
"""shot-diff.py <before dir> <after dir> <out dir> [--tol 24] [--max 0.5]: pixel-diff two home-states.ts runs, shot by shot.

Per pair: the share of pixels whose largest channel difference exceeds --tol (0-255), the bounding box of those pixels, and a
diff image (differing pixels in magenta over a dimmed copy of the after shot). Writes <out>/contact-<size>.png per viewport
(before | after | diff, one row per state and scheme) and <out>/diff.json. Exit 1 if any pair differs on more than --max %
of its pixels or the two runs did not shoot the same states. Needs Pillow + numpy.
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

args = sys.argv[1:]


def opt(k, d):
    if k in args:
        i = args.index(k)
        v = args[i + 1]
        del args[i : i + 2]
        return v
    return d


tol, maxpct = float(opt("--tol", "24")), float(opt("--max", "0.5"))
a_dir, b_dir, out = (Path(x) for x in args[:3])
out.mkdir(parents=True, exist_ok=True)
names = sorted(p.name for p in a_dir.glob("*.png"))
other = sorted(p.name for p in b_dir.glob("*.png"))
res, bad = [], []
if names != other:
    bad.append(
        f"shot sets differ: only before {sorted(set(names) - set(other))}, only after {sorted(set(other) - set(names))}"
    )
rows = {}
for n in names:
    if not (b_dir / n).exists():
        continue
    A = np.asarray(Image.open(a_dir / n).convert("RGB")).astype(np.int16)
    B = np.asarray(Image.open(b_dir / n).convert("RGB")).astype(np.int16)
    if A.shape != B.shape:
        h, w = max(A.shape[0], B.shape[0]), max(A.shape[1], B.shape[1])
        pad = lambda X: np.pad(X, ((0, h - X.shape[0]), (0, w - X.shape[1]), (0, 0)))
        A, B = pad(A), pad(B)
    d = np.abs(A - B).max(axis=2) > tol
    pct = 100.0 * d.mean()
    ys, xs = np.nonzero(d)
    box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())] if len(xs) else None
    vis = (B * 0.35).astype(np.uint8)
    vis[d] = (255, 0, 255)
    Image.fromarray(vis).save(out / n.replace(".png", ".diff.png"))
    r = {"shot": n, "differ_pct": round(pct, 4), "box": box, "size": [int(A.shape[1]), int(A.shape[0])]}
    res.append(r)
    if pct > maxpct:
        bad.append(f"{n}: {pct:.3f}% of pixels differ (box {box})")
    size = n.rsplit("-", 2)[-2]
    rows.setdefault(size, []).append((n, a_dir / n, b_dir / n, out / n.replace(".png", ".diff.png"), pct))
for size, rs in rows.items():
    thumbs = []
    for n, a, b, df, pct in rs:
        ims = [Image.open(p).convert("RGB") for p in (a, b, df)]
        scale = 260 / ims[0].width
        ims = [im.resize((260, int(im.height * scale))) for im in ims]
        row = Image.new("RGB", (3 * 264 + 4, ims[0].height + 22), (20, 20, 24))
        for i, im in enumerate(ims):
            row.paste(im, (4 + i * 264, 22))
        ImageDraw.Draw(row).text((6, 4), f"{n}   before | after | diff {pct:.3f}%", fill=(230, 230, 230))
        thumbs.append(row)
    sheet = Image.new("RGB", (thumbs[0].width, sum(t.height for t in thumbs)), (0, 0, 0))
    y = 0
    for t in thumbs:
        sheet.paste(t, (0, y))
        y += t.height
    sheet.save(out / f"contact-{size}.png")
(out / "diff.json").write_text(json.dumps(res, indent=1))
worst = sorted(res, key=lambda r: -r["differ_pct"])[:8]
print(f"{len(res)} pairs, tol {tol}: worst " + ", ".join(f"{r['shot']} {r['differ_pct']}%" for r in worst))
for b in bad:
    print("DIFF", b)
sys.exit(1 if bad else 0)
