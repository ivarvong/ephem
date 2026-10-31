# Subset D-DIN (Datto, SIL OFL 1.1) for ephem's page, make its figures tabular, rename it (OFL Reserved Font Name), emit woff2.
#   python3 -I scripts/fonts/din.py <D-DIN.otf> <out.woff2> "Ephem DIN" Regular   (and D-DIN-Bold.otf ... Bold), with fonttools + brotli
# Source: D-DIN from Datto (https://www.datto.com/fonts/d-din; fontsquirrel d-din zip, 2026-10-31). Then regenerate
# packages/worker/src/din.ts (base64 of both woff2 files, the OFL text). Subset: ASCII without lowercase, ° · – ’ ← ↑ → ↓ −; kern only.
import sys
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
src, out, family, style = sys.argv[1:5]
opts = subset.Options(); opts.layout_features = ["kern"]; opts.hinting = False; opts.desubroutinize = True; opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]; opts.flavor = None
f = TTFont(src); s = subset.Subsetter(opts)
# no lowercase: every DIN text on the page is set in caps (labels, names, units, values); a stray lowercase letter falls back
s.populate(unicodes=list(range(0x20, 0x61)) + list(range(0x7B, 0x7F)) + [0xB0, 0xB7, 0x2013, 0x2019, 0x2190, 0x2191, 0x2192, 0x2193, 0x2212]); s.subset(f)
cmap = f.getBestCmap(); hm = f["hmtx"].metrics; cff = f["CFF "].cff; top = cff[cff.fontNames[0]]; cs = top.CharStrings; gs = f.getGlyphSet()
digits = [cmap[ord(c)] for c in "0123456789"]; W = max(hm[g][0] for g in digits)
for g in digits:
    adv, lsb = hm[g]; dx = (W - adv) / 2
    pen = T2CharStringPen(W, gs); gs[g].draw(TransformPen(pen, (1, 0, 0, 1, dx, 0)))
    c = pen.getCharString(private=cs[g].private, globalSubrs=cs[g].globalSubrs); cs[g] = c; hm[g] = (W, lsb + round(dx))
# tabular figures by default; the space and colon left alone. Rename: a modified OFL font may not use its Reserved Font Name.
for rec in f["name"].names:
    if rec.nameID in (1, 16): rec.string = family
    elif rec.nameID == 4: rec.string = f"{family} {style}".strip()
    elif rec.nameID == 6: rec.string = (family + "-" + style).replace(" ", "")
    elif rec.nameID == 3: rec.string = f"ephem;{family};{style}"
top.FamilyName = family; top.FullName = f"{family} {style}"
f.flavor = "woff2"; f.save(out); print(out, "digits ->", W)
