"""Build the WOFF2 web subsets of Liberation Sans / Liberation Mono 2.1.5 that the app loads.

    uv run --with 'fonttools==4.66.1' --with 'brotli==1.2.0' python fonts/build-subsets.py

(run from the neuroguesser/ folder). It reads the unmodified Liberation TTFs in this folder (kept as the subset
source; the page no longer loads them) and writes NGSans-{Regular,Bold,Italic}.woff2 and NGMono-Regular.woff2.

- Coverage: Basic Latin, Latin-1, Latin Extended-A, Greek, general punctuation, super/subscripts, currency,
  letterlike symbols, number forms, arrows, maths operators, geometric shapes, U+FFFD. Every glyph the app and the
  season content use that Liberation has is in it (the build fails otherwise). Glyphs Liberation never had
  (✓ ✕ ↻ ↗ ⤢ ⟲ ✥ ✎ ⋮ ∈ ∝ ∪ ⌊ ⌋ ▶) keep falling back to the next fonts in --font-sans / --font-mono, as before.
- Unhinted (TrueType instructions dropped, gasp = smooth at every size): phones and macOS ignore hinting; it
  doubled the file size. GPOS kerning is kept; the combining marks (U+0300-036F) and the features that only serve
  them or are unused here (mark, mkmk, ccmp, sups, subs, dlig, locl, legacy kern table) are not. Decomposed input
  ("e" + U+0301) still renders like the TTF: the shaper composes it to the precomposed letter.
- Renamed "NG Sans" / "NG Mono": a subset is a Modified Version under the SIL OFL 1.1, which may not use the
  Reserved Font Names (Liberation, Arimo, Cousine). Copyright, trademark and licence records are kept; OFL.txt
  applies to the subsets too.
"""
import io
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont, newTable

HERE = Path(__file__).resolve().parent

UNICODES = (
    'U+0020-007E,U+00A0-017F,'           # Basic Latin, Latin-1, Latin Extended-A
    'U+0192,U+02C6-02C7,U+02C9,U+02D8-02DD,'  # ƒ and the spacing accents of Windows-1252 / WGL4
    'U+0370-03FF,'                        # Greek and Coptic
    'U+2000-206F,U+2070-209F,U+20A0-20CF,'  # punctuation (– — ‘ ’ “ ” … ′ ″ ‹ ›), super/subscripts, currency
    'U+2100-218F,U+2190-21FF,U+2200-22FF,'  # letterlike (µ-adjacent ℓ № ™ Ω), number forms, arrows, maths
    'U+25A0-25FF,U+FFFD'                  # geometric shapes (■ □ ▲ ▼ ● ▬), replacement character
)

# Non-ASCII glyphs used by js/, css/, the contracts' scoring text and the baked season (grep, 3 Oct 2026).
USED = '§±²³µ·×ΔΣΩαβγ–—‘’“”…›←↑→↓↔−√≈≠≤≥■□▲▼●' + '✓✕↻↗⤢⟲✥✎⋮∈∝∪⌊⌋▶'
NOT_IN_LIBERATION = set('✓✕↻↗⤢⟲✥✎⋮∈∝∪⌊⌋▶')

FACES = [
    # source TTF, output, family, style, PostScript name
    ('LiberationSans-Regular.ttf', 'NGSans-Regular.woff2', 'NG Sans', 'Regular', 'NGSans-Regular'),
    ('LiberationSans-Bold.ttf', 'NGSans-Bold.woff2', 'NG Sans', 'Bold', 'NGSans-Bold'),
    ('LiberationSans-Italic.ttf', 'NGSans-Italic.woff2', 'NG Sans', 'Italic', 'NGSans-Italic'),
    ('LiberationMono-Regular.ttf', 'NGMono-Regular.woff2', 'NG Mono', 'Regular', 'NGMono-Regular'),
]


def rename(font, family, style, ps):
    full = family if style == 'Regular' else f'{family} {style}'
    names = {
        1: family, 2: style, 3: f'{ps};2.1.5-ng1', 4: full, 5: 'Version 2.1.5; NeuroGuesser subset 1', 6: ps,
    }
    table = font['name']
    for rec in table.names:
        if rec.nameID in names:
            rec.string = names[rec.nameID]
        elif rec.nameID == 10:
            rec.string = (f'{rec.toUnicode()} This file is a renamed web subset of Liberation 2.1.5 '
                          '(Latin, Greek, punctuation, arrows, maths, shapes; unhinted) made for NeuroGuesser.')
    table.names = [r for r in table.names if r.nameID not in (16, 17, 18, 21, 22)]


def build(src, dst, family, style, ps):
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.hinting = False
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.name_legacy = False          # Windows (platform 3) records only
    opts.notdef_outline = True
    opts.drop_tables += ['FFTM']
    font = TTFont(HERE / src, recalcTimestamp=False)  # keep head.modified: same bytes on every rebuild
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}  # unhinted: grey-scale + symmetric smoothing at every size
    font['gasp'] = gasp
    rename(font, family, style, ps)
    cmap = font.getBestCmap()
    missing = [c for c in USED if c not in NOT_IN_LIBERATION and ord(c) not in cmap]
    if missing:
        sys.exit(f'{dst}: glyphs used by the app are missing: {"".join(missing)}')
    font.flavor = 'woff2'
    buf = io.BytesIO()
    font.save(buf)
    (HERE / dst).write_bytes(buf.getvalue())
    return len(cmap), len(font.getGlyphOrder()), len(buf.getvalue())


if __name__ == '__main__':
    for face in FACES:
        n_cp, n_gl, size = build(*face)
        src_size = (HERE / face[0]).stat().st_size
        print(f'{face[1]:24s} {n_cp:4d} code points  {n_gl:4d} glyphs  {size:7,d} B  (TTF {src_size:,d} B)')
