# Build "Ephem DIN" from D-DIN (Datto, SIL OFL 1.1): both weights as woff2 into packages/web/src/fonts/ (the web build hashes
# them; the page and glyph, the OG image, fetch the same bytes, glyph by sha256), and packages/worker/src/din.ts (their advances
# for the OG layout, the licence).
#   python3 -I scripts/fonts/din.py <D-DIN.otf> <D-DIN-Bold.otf> <SIL Open Font License.txt> packages/worker/src/din.ts   (fonttools + brotli)
# Source: D-DIN from Datto (https://www.datto.com/fonts/d-din; https://www.fontsquirrel.com/fonts/download/d-din, 2026-10-31):
#   D-DIN.otf 6d67834e2a76646c456c087ce42a6bd6b6b0c85c88dd9918618a8b4c563c2bdf, D-DIN-Bold.otf b0f96a3730041605b139ca2d15e29a36c55e49058ba2b72ee4d09b5e4ca210c1.
# Subset (every DIN text on the page and the OG card is set in caps; a lowercase letter or anything else falls back to the system
# face on the page, and to Noto Sans in the OG card, src/og.ts): printable ASCII without lowercase, NBSP ° · ’ ‘ “ ” – —,
# the Latin-1 capitals, Œ Š Ÿ Ž, and (2026-10-31, place names: Tromsø, Kraków, İstanbul, Győr, Rīga, Timișoara…) every Latin
# Extended-A capital but Ŋ plus Ș Ț, which D-DIN lacks, composed here from its own letters and accents (the cap accents sit
# where D-DIN puts Á's; breve, ogonek, double acute, comma below, the bars of Ł Ħ Ŧ are drawn to its strokes), plus − ← ↑ → ↓.
# Composed capitals kern like their base letter (class kerning). Figures are made tabular. Renamed (OFL Reserved Font Name).
import os
import base64, json, sys, unicodedata
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen

FAMILY = "Ephem DIN"
KEEP = (list(range(0x20, 0x61)) + list(range(0x7B, 0x7F)) + [0xA0, 0xB0, 0xB7] + [c for c in range(0xC0, 0xDF) if c != 0xD7]
        + [0x152, 0x160, 0x178, 0x17D, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D])
# Latin Extended-A capitals (Ŋ left to the fallback) and Romanian comma-below Ș Ț
COMPOSE = [c for c in range(0x100, 0x17F) if chr(c).isupper() and c not in (0x14A, 0x152, 0x160, 0x178, 0x17D)] + [0x218, 0x21A]
MARK = {"0300": "grave", "0301": "acute", "0302": "circumflex", "0303": "tilde", "0304": "macron", "0306": "breve", "0307": "dotaccent",
        "0308": "dieresis", "030A": "ring", "030B": "dblacute", "030C": "caron", "0326": "commabelow", "0327": "cedilla", "0328": "ogonek"}
REF = {"grave": ("Agrave", "A"), "acute": ("Aacute", "A"), "circumflex": ("Acircumflex", "A"), "tilde": ("Atilde", "A"),
       "dieresis": ("Adieresis", "A"), "caron": ("Scaron", "S")}   # D-DIN's own cap accents: placement measured from these


def build(src):
    f = TTFont(src); cmap = f.getBestCmap(); gs = f.getGlyphSet(); hm = f["hmtx"].metrics
    cff = f["CFF "].cff; top = cff[cff.fontNames[0]]; cs = top.CharStrings
    G = lambda ch: cmap[ord(ch)]

    def bounds(draw):
        p = BoundsPen(gs); draw(p); return p.bounds
    def gbounds(g): return bounds(lambda p: gs[g].draw(p))
    def contours(g):
        p = RecordingPen(); gs[g].draw(p); out, cur = [], []
        for op, a in p.value:
            cur.append((op, a))
            if op in ("closePath", "endPath"): out.append(cur); cur = []
        return out
    def replay(c, pen):
        for op, a in c: getattr(pen, op)(*a)
    def poly(pen, pts):   # a closed polygon, counter-clockwise like D-DIN's outer contours
        pen.moveTo(pts[0])
        for q in pts[1:]: pen.lineTo(q)
        pen.closePath()
    cx = lambda b: (b[0] + b[2]) / 2

    # stroke weights from D-DIN itself: the hyphen's thickness, the plus's bar, L's stem
    hb = gbounds("hyphen"); T = hb[3] - hb[1]; HY = (hb[1] + hb[3]) / 2
    plus = RecordingPen(); gs["plus"].draw(plus); ys = sorted({a[0][1] for op, a in plus.value if a}); xs = sorted({a[0][0] for op, a in plus.value if a})
    BAR = (ys[1], ys[2])   # the plus's horizontal bar
    # the cap accents: D-DIN's spacing accents raised to where Á/À/Â/Ã/Ä/Š carry theirs
    lift = gbounds("Aacute")[3] - gbounds("acute")[3]
    acc = {}
    for m, (ref, base) in REF.items():
        extra = contours(ref)[len(contours(base)):]
        rb = bounds(lambda p: [replay(c, p) for c in extra])
        acc[m] = (rb[0] - cx(gbounds(base)), rb[1] - gbounds(m)[1])   # (left edge from the base's ink centre, dy)
    capTop = gbounds("acute")[1] + lift   # bottom of a cap accent
    SW = _STEM["L"][1] - _STEM["L"][0]   # stem width

    def mark(pen, m, b, base):
        """Draw mark m over/under base glyph `base` whose ink bounds are b."""
        c = cx(b)
        if m in acc:   # placed as on D-DIN's own A/S: left edge relative to the base's ink centre
            dx, dy = acc[m]; gs[m].draw(TransformPen(pen, (1, 0, 0, 1, c + dx - gbounds(m)[0], dy)))
        elif m in ("macron", "dotaccent", "ring"):   # centred over the base as the spacing accent is over its 500 advance
            gs[m].draw(TransformPen(pen, (1, 0, 0, 1, c - 250, lift)))
        elif m == "dblacute":
            ab = gbounds("acute"); dx = c - cx(ab)
            for s in (-1, 1):
                k = 0.86; ox = cx(ab)
                gs["acute"].draw(TransformPen(pen, (k, 0, 0, 1, dx + ox * (1 - k) + s * 0.36 * (ab[2] - ab[0]), lift)))
        elif m == "breve":
            w = gbounds("circumflex"); rx = (w[2] - w[0]) * 0.44; ry = rx * 0.78; t = T * 0.92
            y0 = capTop + ry; k = 0.5523
            pen.moveTo((c - rx, y0))
            pen.curveTo((c - rx, y0 - ry * k), (c - rx * k, y0 - ry), (c, y0 - ry))
            pen.curveTo((c + rx * k, y0 - ry), (c + rx, y0 - ry * k), (c + rx, y0))
            ri, rj = rx - t * 1.05, ry - t
            pen.lineTo((c + ri, y0))
            pen.curveTo((c + ri, y0 - rj * k), (c + ri * k, y0 - rj), (c, y0 - rj))
            pen.curveTo((c - ri * k, y0 - rj), (c - ri, y0 - rj * k), (c - ri, y0))
            pen.closePath()
        elif m == "cedilla":
            gs["cedilla"].draw(TransformPen(pen, (1, 0, 0, 1, c - 250, 0)))
        elif m == "ogonek":   # a hook of the stem's weight, hung from the right foot (A, E) or the middle (I, U)
            t = SW * 0.8
            x0 = {"A": b[2] - SW * 1.05, "E": b[2] - SW * 1.6, "U": c + SW * 0.2}.get(base, c - t / 2)
            pen.moveTo((x0, 12))
            pen.curveTo((x0 - t * 0.9, -40), (x0 - t * 0.9, -160), (x0 + t * 1.9, -162))
            pen.lineTo((x0 + t * 1.9, -162 + t * 0.75))
            pen.curveTo((x0 + t * 0.4, -162 + t * 0.85), (x0 + t * 0.05, -60), (x0 + t, 12))
            pen.closePath()
        elif m == "commabelow":
            k = 0.68; cb = gbounds("comma")
            gs["comma"].draw(TransformPen(pen, (k, 0, 0, k, c - cx(cb) * k, -cb[3] * k - 34)))

    new = {}
    def add(cp, adv, draw, like=None):
        name = "uni%04X" % cp
        p = T2CharStringPen(adv, gs); draw(p)
        c = p.getCharString(private=cs["A"].private, globalSubrs=cs["A"].globalSubrs)
        top.charset.append(name); cs.charStrings[name] = len(cs.charStringsIndex); cs.charStringsIndex.append(c)
        hm[name] = (adv, round(bounds(draw)[0])); new[name] = like
        for t in f["cmap"].tables:
            if t.isUnicode(): t.cmap[cp] = name

    for cp in COMPOSE:
        ch = chr(cp); d = unicodedata.decomposition(ch).split()
        if cp == 0x110:   # Đ is Ð
            add(cp, hm[G("Ð")][0], lambda p: gs[G("Ð")].draw(p), "Eth"); continue
        if cp == 0x132:   # Ĳ
            add(cp, hm["I"][0] + hm["J"][0], lambda p: (gs["I"].draw(p), gs["J"].draw(TransformPen(p, (1, 0, 0, 1, hm["I"][0], 0))))); continue
        if cp == 0x13F:   # Ŀ: L and a middle dot
            db = gbounds("periodcentered")
            add(cp, hm["L"][0], lambda p, db=db: (gs["L"].draw(p), gs["periodcentered"].draw(TransformPen(p, (1, 0, 0, 1, stemR("L") + 70 - db[0], HY - (db[1] + db[3]) / 2)))), "L"); continue
        if cp in (0x141, 0x126, 0x166):   # Ł Ħ Ŧ: a bar of the hyphen's weight
            base = {0x141: "L", 0x126: "H", 0x166: "T"}[cp]; b = gbounds(base)
            def draw(p, base=base, b=b, cp=cp):
                gs[base].draw(p)
                if cp == 0x141:
                    s0, s1 = stemL(base), stemR(base); m = (s0 + s1) / 2; xl, xr = s0 - 0.75 * (s1 - s0) - 20, s1 + 1.35 * (s1 - s0) + 30; k = 0.62; y = 352
                    poly(p, [(xl, y + (xl - m) * k - T / 2), (xr, y + (xr - m) * k - T / 2), (xr, y + (xr - m) * k + T / 2), (xl, y + (xl - m) * k + T / 2)])
                elif cp == 0x126:
                    y = 532; poly(p, [(b[0] - 42, y - T / 2), (b[2] + 42, y - T / 2), (b[2] + 42, y + T / 2), (b[0] - 42, y + T / 2)])
                else:
                    m = cx(b); w = 0.33 * (b[2] - b[0]); y = 330; poly(p, [(m - w, y - T / 2), (m + w, y - T / 2), (m + w, y + T / 2), (m - w, y + T / 2)])
            adv = hm[base][0] + (84 if cp == 0x126 else 0)
            add(cp, adv, (lambda p, draw=draw: draw(TransformPen(p, (1, 0, 0, 1, 42, 0)))) if cp == 0x126 else draw, base); continue
        base = chr(int(d[0], 16)); m = MARK[d[1]]; bg = G(base); b = gbounds(bg)
        if base in "GKLNR" and m == "cedilla": m = "commabelow"   # Latvian Ģ Ķ Ļ Ņ Ŗ: a comma below
        if cp == 0x13D:   # Ľ: the caron as a stroke right of the stem
            qb = gbounds("quoteright")
            add(cp, hm["L"][0], lambda p: (gs["L"].draw(p), gs["quoteright"].draw(TransformPen(p, (1, 0, 0, 1, stemR("L") + 48 - qb[0], b[3] - qb[3])))), "L"); continue
        add(cp, hm[bg][0], lambda p, bg=bg, b=b, m=m, base=base: (gs[bg].draw(p), mark(p, m, b, base)), bg)

    # − ← ↑ → ↓
    add(0x2212, hm["plus"][0], lambda p: poly(p, [(xs[0], BAR[0]), (xs[-1], BAR[0]), (xs[-1], BAR[1]), (xs[0], BAR[1])]))
    def arrow(p, rot):
        L, W = 470, 0.62 * 470; sh = [(0, -T / 2), (L - W * 0.55, -T / 2), (L - W * 0.55, T / 2), (0, T / 2)]
        hd = [(L - W * 0.62, -W / 2), (L, 0), (L - W * 0.62, W / 2)]
        q = lambda pts: [(rot(x - L / 2, y)) for x, y in pts]
        poly(p, q(sh)); poly(p, q(hd))
    adv_h, adv_v = 470 + 120, round(0.62 * 470) + 120
    for cp, adv, rot in ((0x2192, adv_h, lambda x, y: (x + adv_h / 2, HY + y)), (0x2190, adv_h, lambda x, y: (adv_h / 2 - x, HY - y)),
                         (0x2191, adv_v, lambda x, y: (adv_v / 2 - y, HY + x)), (0x2193, adv_v, lambda x, y: (adv_v / 2 + y, HY - x))):
        add(cp, adv, lambda p, rot=rot: arrow(p, rot))
    f.setGlyphOrder(f.getGlyphOrder() + [n for n in new if n not in f.getGlyphOrder()])

    # class kerning: a composed capital kerns like its base
    for lk in f["GPOS"].table.LookupList.Lookup:
        for st in lk.SubTable:
            if getattr(st, "Format", None) != 2: continue
            for n, like in new.items():
                if not like: continue
                if like in st.Coverage.glyphs:
                    st.Coverage.glyphs.append(n)
                    if like in st.ClassDef1.classDefs: st.ClassDef1.classDefs[n] = st.ClassDef1.classDefs[like]
                if like in st.ClassDef2.classDefs: st.ClassDef2.classDefs[n] = st.ClassDef2.classDefs[like]
            order = {g: i for i, g in enumerate(f.getGlyphOrder())}; st.Coverage.glyphs.sort(key=order.get)

    opts = subset.Options(); opts.layout_features = ["kern"]; opts.hinting = False; opts.desubroutinize = True
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]; opts.drop_tables += ["FFTM"]
    s = subset.Subsetter(opts); s.populate(unicodes=KEEP + COMPOSE + [0x2212, 0x2190, 0x2191, 0x2192, 0x2193]); s.subset(f)
    return f


def stemL(g): return _stem(g)[0]
def stemR(g): return _stem(g)[1]
_STEM = {}
def _stem(g): return _STEM[g]


def finish(f, style):
    cmap = f.getBestCmap(); hm = f["hmtx"].metrics; cff = f["CFF "].cff; top = cff[cff.fontNames[0]]; cs = top.CharStrings; gs = f.getGlyphSet()
    digits = [cmap[ord(c)] for c in "0123456789"]; W = max(hm[g][0] for g in digits)
    for g in digits:   # tabular figures by default; the space and colon left alone
        adv, lsb = hm[g]; dx = (W - adv) / 2
        pen = T2CharStringPen(W, gs); gs[g].draw(TransformPen(pen, (1, 0, 0, 1, dx, 0)))
        cs[g] = pen.getCharString(private=cs[g].private, globalSubrs=cs[g].globalSubrs); hm[g] = (W, lsb + round(dx))
    for rec in f["name"].names:   # a modified OFL font may not use its Reserved Font Name
        if rec.nameID in (1, 16): rec.string = FAMILY
        elif rec.nameID == 4: rec.string = f"{FAMILY} {style}"
        elif rec.nameID == 6: rec.string = (FAMILY + "-" + style).replace(" ", "")
        elif rec.nameID == 3: rec.string = f"ephem;{FAMILY};{style}"
    top.FamilyName = FAMILY; top.FullName = f"{FAMILY} {style}"
    f.recalcTimestamp = False; f["head"].modified = f["head"].created   # reproducible bytes: the sha256 is pinned
    f.flavor = "woff2"
    import io; b = io.BytesIO(); f.save(b)
    adv = {chr(cp): hm[g][0] for cp, g in sorted(cmap.items())}
    return b.getvalue(), adv


if __name__ == "__main__":
    reg, bold, lic, out = sys.argv[1:5]
    res = {}
    for style, src in (("Regular", reg), ("Bold", bold)):
        t = TTFont(src); r = RecordingPen()
        for g in ("L",):
            r = RecordingPen(); t.getGlyphSet()[g].draw(r)
            xs = sorted({a[0][0] for op, a in r.value if a}); _STEM[g] = (xs[0], xs[1])
        res[style] = finish(build(src), style)
        print(style, len(res[style][0]), "B,", len(res[style][1]), "characters")
    assert res["Regular"][1].keys() == res["Bold"][1].keys()
    licence = open(lic, newline="").read().replace("\r\n", "\n").strip()
    chars = "".join(res["Regular"][1])
    fonts = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../packages/web/src/fonts")
    for style in ("Regular", "Bold"):
        f = os.path.join(fonts, f"ephem-din-{style.lower()}.woff2"); open(f, "wb").write(res[style][0]); print(f)
    ts = f'''// GENERATED by scripts/fonts/din.py (see its header): "Ephem DIN", a subset of D-DIN (Datto Inc., SIL Open Font License 1.1)
// with tabular figures and composed Latin Extended-A capitals, renamed as the OFL requires of a modified font (Reserved Font
// Name "D-DIN"). The font files are packages/web/src/fonts/ephem-din-{{regular,bold}}.woff2 (hashed by the web build, served as
// immutable static assets); the page and glyph (src/og-fonts.ts) fetch the same bytes. This module keeps what the server needs.
// Regular {len(res["Regular"][0])} B, Bold {len(res["Bold"][0])} B (woff2), {len(chars)} characters. The licence ships with it: DIN_LICENSE (served at /licenses/din.txt).
export const DIN_LICENSE = {json.dumps(licence)}
/** Every character the font maps, and its advance (1000 units/em) per weight (generated into @ephem/web lib/din-metrics.ts). */
export {{ DIN_ADV }} from "@ephem/web/lib/din-metrics"
'''
    open(out, "w").write(ts); print(out)
    metrics = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../packages/web/src/lib/din-metrics.ts")
    open(metrics, "w").write(f'''// GENERATED by scripts/fonts/din.py (see its header): "Ephem DIN"'s advances, per weight, for every character it maps. The page
// lays out its chart labels with these (not with the browser's text measurement), so the server and the browser compute the
// same layout before the font has loaded (lib/chart.ts textWidth); the OG card (packages/worker/src/og.ts) uses them too.
/** Every character the font maps, and its advance (1000 units/em) per weight: src/og.ts lays out with these. */
export const DIN_ADV: {{ readonly r: Readonly<Record<string, number>>; readonly b: Readonly<Record<string, number>> }} = {{
  r: {json.dumps(res["Regular"][1], ensure_ascii=False, separators=(",", ":"))},
  b: {json.dumps(res["Bold"][1], ensure_ascii=False, separators=(",", ":"))},
}}
'''); print(metrics)
