"""Build the WOFF2 web subsets of Figtree and Geist Mono that the app loads (App Design Guide, 12 Oct 2026: Figtree
for all UI text, Geist Mono for numerals only).

    uv run --with 'fonttools==4.66.1' --with 'brotli==1.2.0' python fonts/build-app-fonts.py

(run from the neuroguesser/ folder). Sources are the variable TTFs from github.com/google/fonts (ofl/figtree,
ofl/geistmono), kept unmodified in this folder; their licences are OFL-Figtree.txt and OFL-GeistMono.txt. Neither
declares a Reserved Font Name, so the subsets keep their family names.

- Weight axis limited to what the app uses: Figtree 400-700 (400 reading, 600 emphasis, 700 the cell's name), Figtree
  Italic pinned to 400 (species names and gene symbols), Geist Mono 400-500.
- Coverage: the same ranges as build-subsets.py (Latin-1, Latin Extended-A, Greek, punctuation, arrows, maths,
  shapes); a glyph a face lacks (Greek letters, ✓ ✕ ↻ ↗ ⤢ …) falls back per character to the rest of the stack.
- Unhinted, like the Liberation subsets: phones and macOS ignore hinting.
"""
import io
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont, newTable
from fontTools.varLib import instancer

HERE = Path(__file__).resolve().parent

UNICODES = (
    'U+0020-007E,U+00A0-017F,'
    'U+0192,U+02C6-02C7,U+02C9,U+02D8-02DD,'
    'U+0370-03FF,'
    'U+2000-206F,U+2070-209F,U+20A0-20CF,'
    'U+2100-218F,U+2190-21FF,U+2200-22FF,'
    'U+25A0-25FF,U+FFFD'
)

FACES = [
    # source, output, wght limits (min, max) or a single pinned value
    ('Figtree[wght].ttf', 'Figtree-Var.woff2', (400, 700)),
    ('Figtree-Italic[wght].ttf', 'Figtree-Italic.woff2', 400),
    ('GeistMono[wght].ttf', 'GeistMono-Var.woff2', (400, 500)),
]


def build(src, dst, wght):
    font = TTFont(HERE / src, recalcTimestamp=False, lazy=False)
    limits = {'wght': wght if isinstance(wght, int) else instancer.AxisTriple(wght[0], wght[0], wght[1])}
    # instance through a save / reload: subsetting the instancer's in-memory result trips on its lazy gvar
    tmp = io.BytesIO()
    instancer.instantiateVariableFont(font, limits).save(tmp)
    tmp.seek(0)
    font = TTFont(tmp, recalcTimestamp=False)
    opts = subset.Options()
    opts.flavor = 'woff2'
    opts.hinting = False
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    opts.notdef_outline = True
    opts.layout_features = ['kern', 'liga', 'calt', 'tnum', 'lnum', 'case']
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    gasp = newTable('gasp')
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    font['gasp'] = gasp
    font.flavor = 'woff2'
    buf = io.BytesIO()
    font.save(buf)
    (HERE / dst).write_bytes(buf.getvalue())
    return len(font.getBestCmap()), len(buf.getvalue())


if __name__ == '__main__':
    for src, dst, wght in FACES:
        n_cp, size = build(src, dst, wght)
        print(f'{dst:24s} {n_cp:4d} code points  {size:7,d} B  (TTF {(HERE / src).stat().st_size:,d} B)')
