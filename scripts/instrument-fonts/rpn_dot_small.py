# "RPN Dot Small": an original proportional 3x5 face for soft-menu labels and the two status lines, 1 dot = 100 units.
# From the RPN Instrument design system's tools/build_small.py (reproduces its shipped font outline-for-outline), changed for
# ephem's /instrument (2026-10-30): the status-line punctuation a 48-style header needs ({ } ( ) [ ] : , _ " ' * × ÷ √ < > !
# π … and the shift annunciators ↰ ↱), a Q with a real tail, and dots that fill the whole cell (INK 100; the page draws seams).
# Advance = ink width + 1 dot. src/instrument-engine.ts carries the same widths (SMALL_W); test/instrument-engine.test.ts
# checks them against this file.
#   python3 scripts/instrument-fonts/rpn_dot_small.py <out.woff2>      (needs fontTools)
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
S = {}
def g(ch, *rows): S[ch] = rows
g('A','.#.','#.#','###','#.#','#.#'); g('B','##.','#.#','##.','#.#','##.'); g('C','.##','#..','#..','#..','.##')
g('D','##.','#.#','#.#','#.#','##.'); g('E','###','#..','##.','#..','###'); g('F','###','#..','##.','#..','#..')
g('G','.##','#..','#.#','#.#','.##'); g('H','#.#','#.#','###','#.#','#.#'); g('I','#','#','#','#','#')
g('J','..#','..#','..#','#.#','.#.'); g('K','#.#','#.#','##.','#.#','#.#'); g('L','#..','#..','#..','#..','###')
g('M','#...#','##.##','#.#.#','#...#','#...#'); g('N','#..#','##.#','#.##','#..#','#..#'); g('O','.#.','#.#','#.#','#.#','.#.')
g('P','##.','#.#','##.','#..','#..'); g('Q','.#.','#.#','#.#','##.','.##'); g('R','##.','#.#','##.','#.#','#.#')
g('S','.##','#..','.#.','..#','##.'); g('T','###','.#.','.#.','.#.','.#.'); g('U','#.#','#.#','#.#','#.#','###')
g('V','#.#','#.#','#.#','#.#','.#.'); g('W','#...#','#...#','#.#.#','##.##','#...#'); g('X','#.#','#.#','.#.','#.#','#.#')
g('Y','#.#','#.#','.#.','.#.','.#.'); g('Z','###','..#','.#.','#..','###')
g('0','###','#.#','#.#','#.#','###'); g('1','.#.','##.','.#.','.#.','###'); g('2','##.','..#','.#.','#..','###')
g('3','##.','..#','.#.','..#','##.'); g('4','#.#','#.#','###','..#','..#'); g('5','###','#..','##.','..#','##.')
g('6','.##','#..','###','#.#','###'); g('7','###','..#','.#.','.#.','.#.'); g('8','###','#.#','###','#.#','###'); g('9','###','#.#','###','..#','##.')
g('.','.','.','.','.','#'); g('-','...','...','###','...','...'); g('+','...','.#.','###','.#.','...'); g('/','..#','..#','.#.','#..','#..')
g('%','#.#','..#','.#.','#..','#.#'); g('?','##.','..#','.#.','...','.#.'); g('=','...','###','...','###','...'); g('^','.#.','#.#','...','...','...')
g('→','....','..#.','####','..#.','....'); g('←','....','.#..','####','.#..','....'); g('Σ','###','#..','.#.','#..','###')
g('°','###','#.#','###','...','...'); g(' ','..','..','..','..','..')
g('{','.##','.#.','#..','.#.','.##'); g('}','##.','.#.','..#','.#.','##.'); g('(','.#','#.','#.','#.','.#'); g(')','#.','.#','.#','.#','#.')
g('[','##','#.','#.','#.','##'); g(']','##','.#','.#','.#','##'); g(':','.','#','.','#','.'); g(',','..','..','..','.#','#.')
g('_','...','...','...','...','###'); g('"','#.#','#.#','...','...','...'); g("'",'#','#','.','.','.'); g('!','#','#','#','.','#')
g('*','...','#.#','.#.','#.#','...'); g('×','...','#.#','.#.','#.#','...'); g('÷','.#.','...','###','...','.#.')
g('√','..##','..#.','#.#.','#.#.','.#..'); g('<','..#','.#.','#..','.#.','..#'); g('>','#..','.#.','..#','.#.','#..')
g('π','####','.#.#','.#.#','.#.#','.#.#'); g('…','.....','.....','.....','.....','#.#.#')
g('↰','.#..','####','.#.#','...#','...#'); g('↱','..#.','####','#.#.','#...','#...')
for ch, rows in S.items():   # 5 rows (caps only), one width per glyph
    assert len(rows) == 5 and len(set(map(len, rows))) == 1, ch
U, INK = 100, 100
def glyph(rows):
    pen = TTGlyphPen(None)
    for r, row in enumerate(rows):
        for c, v in enumerate(row):
            if v == '#':
                x0 = c*U + (U-INK)//2; y0 = (4-r)*U + (U-INK)//2
                pen.moveTo((x0,y0)); pen.lineTo((x0,y0+INK)); pen.lineTo((x0+INK,y0+INK)); pen.lineTo((x0+INK,y0)); pen.closePath()
    return pen.glyph()
for ch in 'abcdefghijklmnopqrstuvwxyz': S[ch] = S[ch.upper()]
names = {ch: ('space' if ch == ' ' else 'uni%04X' % ord(ch)) for ch in S}
order = ['.notdef'] + list(dict.fromkeys(names[c] for c in S))
gl = {'.notdef': glyph(['###','#.#','#.#','#.#','###'])}
mt = {'.notdef': (400, 0)}
for ch, rows in S.items():
    gl[names[ch]] = glyph(rows); mt[names[ch]] = ((len(rows[0]) + 1) * U, 0)
fb = FontBuilder(1000, isTTF=True); fb.setupGlyphOrder(order)
fb.setupCharacterMap({ord(c): names[c] for c in S}); fb.setupGlyf(gl); fb.setupHorizontalMetrics(mt)
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({'familyName': 'RPN Dot Small', 'styleName': 'Regular', 'uniqueFontIdentifier': 'RPN Dot Small Regular 1.0', 'fullName': 'RPN Dot Small Regular',
  'psName': 'RPNDotSmall-Regular', 'version': 'Version 1.000', 'copyright': 'Original design for the RPN Instrument design system, 2026.', 'licenseDescription': 'SIL Open Font License 1.1'})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, sTypoLineGap=0, usWinAscent=800, usWinDescent=200, sCapHeight=500, fsType=0, achVendID='RPN ')
fb.setupPost(); fb.font.flavor = 'woff2'; fb.save(sys.argv[1]); print(len(S), 'glyphs')
