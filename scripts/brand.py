#!/usr/bin/env python3
"""SQL Yodeler's brand assets: the pixel-art hat and the database icon.

    python3 scripts/brand.py                 # every asset, from docs-site/public/brand/hat-source.png
    python3 scripts/brand.py --from art.png  # first rebuild hat-source.png from a rendered hat

hat-source.png is the hat as art pixels: 78x72, transparent, 18 colours. It
was made with --from from a 1024x1024 render of the hat on a near-white
background. That render's pixel grid is soft (its steps run 4 to 8 source
pixels), so --from samples a coarser grid, 72 art pixels tall (about 11.7
source pixels each), takes the median colour of each cell's middle, drops
cells that are mostly background (which removes the white fringe), and
quantizes the hat's browns, the cylinder's blues and yellows and the outline
darks to their own small palettes, so the cylinder keeps its colours.

Every other file is drawn from hat-source.png, or for the database icon from
the grid below, and the script overwrites them all. Needs Python 3 with
Pillow and NumPy.
"""

import argparse
import base64
import colorsys
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "docs-site" / "public"
BRAND = PUBLIC / "brand"
SOURCE = BRAND / "hat-source.png"

ROWS = 72  # art pixels from the hat's top to its brim
PALETTE = {"dark": 2, "blue": 5, "yellow": 5, "brown": 6}

# The cylinder's colours, taken from hat-source.png: the yellow top and the blue body.
YELLOW = "#f7d136"
BLUE = "#0f57a4"
INK = "#17181c"  # Starlight's text colour in light mode
MUTED = "#545861"


# ---------------------------------------------------------------- the hat's art


def clean(render: Path) -> Image.Image:
    """The rendered hat as art pixels: background removed, cropped, quantized."""
    a = np.asarray(Image.open(render).convert("RGB")).astype(float)
    edge = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    bg = np.median(edge, axis=0)
    mask = np.abs(a - bg).sum(2) > 60
    ys, xs = np.where(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    cell = (y1 - y0) / ROWS
    cols = int(round((x1 - x0) / cell))
    left = (x0 + x1) / 2 - cols * cell / 2
    rgb = np.zeros((ROWS, cols, 3))
    on = np.zeros((ROWS, cols), bool)
    for r in range(ROWS):
        for c in range(cols):
            ya, yb = int(round(y0 + r * cell)), int(round(y0 + (r + 1) * cell))
            xa, xb = int(round(left + c * cell)), int(round(left + (c + 1) * cell))
            blk, m = a[ya:yb, xa:xb], mask[ya:yb, xa:xb]
            if not m.size or m.mean() < 0.5:
                continue
            # The middle of the cell, clear of the soft edges between art pixels,
            # and only pixels well away from the background, so the fringe adds nothing.
            iy, ix = max(1, (yb - ya) // 4), max(1, (xb - xa) // 4)
            inner, im = blk[iy:-iy, ix:-ix].reshape(-1, 3), m[iy:-iy, ix:-ix].reshape(-1)
            core = inner[im] if im.any() else blk.reshape(-1, 3)[m.reshape(-1)]
            strong = core[np.abs(core - bg).sum(1) > 120]
            rgb[r, c] = np.median(strong if len(strong) else core, axis=0)
            on[r, c] = True

    def group(px):
        h, s, v = colorsys.rgb_to_hsv(*(px / 255))
        if v < 0.22:
            return "dark"
        if s > 0.35 and 0.5 < h < 0.75:
            return "blue"
        if (s > 0.25 and 0.115 < h < 0.2 and v > 0.6) or (s > 0.9 and h < 0.2 and v > 0.68) or (s < 0.2 and v > 0.93 and 0.12 < h < 0.2):
            return "yellow"
        return "brown"

    flat, onf = rgb.reshape(-1, 3), on.reshape(-1)
    groups = [group(p) if o else None for p, o in zip(flat, onf)]
    out = np.zeros_like(flat)
    for g, k in PALETTE.items():
        idx = [i for i, gg in enumerate(groups) if gg == g]
        if not idx:
            continue
        strip = Image.fromarray(flat[idx].reshape(1, -1, 3).astype(np.uint8), "RGB")
        q = strip.quantize(colors=min(k, len(idx)), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
        out[idx] = np.asarray(q.convert("RGB")).reshape(-1, 3)
    grid = out.reshape(ROWS, cols, 3)

    # Two passes that repaint a lone art pixel the colour most of its neighbours share.
    for _ in range(2):
        nxt = grid.copy()
        for r in range(1, ROWS - 1):
            for c in range(1, cols - 1):
                if not on[r, c]:
                    continue
                nb = [tuple(grid[r + dr, c + dc]) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr or dc) and on[r + dr, c + dc]]
                if len(nb) == 8 and tuple(grid[r, c]) not in nb:
                    best = max(set(nb), key=nb.count)
                    if nb.count(best) >= 5:
                        nxt[r, c] = best
        grid = nxt
    alpha = np.where(on, 255, 0)
    return Image.fromarray(np.dstack([grid, alpha]).astype(np.uint8), "RGBA")


# ---------------------------------------------------------------- the database icon

# 19x20: a yellow top over a blue body of three stacked discs, the gaps between
# the discs left transparent. Y is the top, B the body.
DATABASE = """
.....YYYYYYYYY.....
...YYYYYYYYYYYYY...
.YYYYYYYYYYYYYYYYY.
YYYYYYYYYYYYYYYYYYY
BYYYYYYYYYYYYYYYYYB
BBBYYYYYYYYYYYYYBBB
BBBBBYYYYYYYYYBBBBB
BBBBBBBBBBBBBBBBBBB
.BBBBBBBBBBBBBBBBB.
B..BBBBBBBBBBBBB..B
BBB.............BBB
BBBBBBBBBBBBBBBBBBB
.BBBBBBBBBBBBBBBBB.
B..BBBBBBBBBBBBB..B
BBB.............BBB
BBBBBBBBBBBBBBBBBBB
BBBBBBBBBBBBBBBBBBB
.BBBBBBBBBBBBBBBBB.
...BBBBBBBBBBBBB...
.....BBBBBBBBB.....
"""


def database(colours: dict, mono: bool = False) -> Image.Image:
    """The icon in two colours, or in one with the top's lower edge cut out, like the gaps between the discs."""
    rows = DATABASE.strip("\n").split("\n")
    img = Image.new("RGBA", (len(rows[0]), len(rows)), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if mono and ch == "Y" and y + 1 < len(rows) and rows[y + 1][x] == "B":
                continue
            if ch in colours:
                img.putpixel((x, y), hex_rgba(colours[ch]))
    return img


# ---------------------------------------------------------------- writers


def hex_rgba(h: str) -> tuple:
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16), 255)


def svg_paths(img: Image.Image, dx: int = 0, dy: int = 0) -> str:
    """One <path> per colour, a horizontal run of art pixels per subpath."""
    by = {}
    w, h = img.size
    px = img.load()
    for y in range(h):
        x = 0
        while x < w:
            p = px[x, y]
            if p[3] == 0:
                x += 1
                continue
            run = 1
            while x + run < w and px[x + run, y] == p:
                run += 1
            by.setdefault("#%02x%02x%02x" % p[:3], []).append(f"M{x + dx} {y + dy}h{run}v1h-{run}z")
            x += run
    return "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in sorted(by.items()))


def svg(img: Image.Image) -> str:
    w, h = img.size
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" shape-rendering="crispEdges">{svg_paths(img)}</svg>\n'


def scaled(img: Image.Image, k: int) -> Image.Image:
    return img.resize((img.width * k, img.height * k), Image.NEAREST)


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    """The art resampled once to fit w x h, centred on a transparent canvas."""
    k = min(w / img.width, h / img.height)
    art = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.alpha_composite(art, ((w - art.width) // 2, (h - art.height) // 2))
    return out


def tile(img: Image.Image, size: int, pad: int) -> Image.Image:
    """The art on a white rounded square, for the bitmap favicons."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(out).rounded_rectangle((0, 0, size - 1, size - 1), radius=size // 6, fill=(255, 255, 255, 255))
    out.alpha_composite(fit(img, size - 2 * pad, size - 2 * pad))
    return out


def font(size: int, bold: bool) -> ImageFont.FreeTypeFont:
    candidates = [
        ("/System/Library/Fonts/Avenir Next.ttc", 0 if bold else 5),
        ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 0),
    ]
    for path, index in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size, index=index)
    raise SystemExit("no font for the social preview: install Avenir Next (macOS) or DejaVu Sans")


def wrap(draw: ImageDraw.ImageDraw, text: str, f, width: int) -> list:
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=f) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    return lines + [line]


def social(hat: Image.Image) -> Image.Image:
    """1280x640: the hat at 4x beside the wordmark and the tagline, on white."""
    out = Image.new("RGB", (1280, 640), (255, 255, 255))
    art = scaled(hat, 4)
    out.paste(art, (110, (640 - art.height) // 2), art)
    d = ImageDraw.Draw(out)
    title, body = font(84, True), font(34, False)
    tagline = "Schema management and migrations for ClickHouse and Postgres."
    lines = wrap(d, tagline, body, 640)
    x, line_h = 500, 46
    top = (640 - (100 + 24 + line_h * len(lines))) // 2
    d.text((x, top), "SQL Yodeler", font=title, fill=INK)
    for i, line in enumerate(lines):
        d.text((x, top + 124 + i * line_h), line, font=body, fill=MUTED)
    return out


def share(hat: Image.Image) -> Image.Image:
    """400x400: the hat at 4x, centred on white, the square a shared link shows."""
    out = Image.new("RGB", (400, 400), (255, 255, 255))
    art = scaled(hat, 4)
    out.paste(art, ((400 - art.width) // 2, (400 - art.height) // 2), art)
    return out


def favicon_svg(hat: Image.Image) -> str:
    """The hat on a rounded tile, white in a light browser theme and black in a dark one."""
    side = max(hat.size) + 4
    dx, dy = (side - hat.width) // 2, (side - hat.height) // 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {side}" width="{side}" height="{side}" shape-rendering="crispEdges">'
        '<style>.g{fill:#fff}@media (prefers-color-scheme:dark){.g{fill:#000}}</style>'
        f'<rect class="g" width="{side}" height="{side}" rx="{side // 6}"/>{svg_paths(hat, dx, dy)}</svg>\n'
    )


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def brand_ts(hat: Image.Image) -> str:
    uri = "data:image/png;base64," + base64.b64encode(png_bytes(hat)).decode()
    w, h = hat.size
    return f'''// Written by scripts/brand.py; run it again rather than editing this file.

/**
 * SQL Yodeler's logo, the pixel-art hat, for the pages yodel writes (yodel
 * report --html and yodel docs). The {w}x{h} art is inlined as a PNG data URI so
 * each page stays one self-contained file. Shown at its own size with
 * image-rendering: pixelated, each art pixel stays a sharp square.
 */
export const HAT_PNG = "{uri}";

/** The favicon link a page's head carries. */
export const HAT_ICON = `<link rel="icon" type="image/png" href="${{HAT_PNG}}">`;

/** The hat beside a page's heading; decorative, since the heading names the page. */
export const HAT_IMG = `<img class="hat" src="${{HAT_PNG}}" width="{w}" height="{h}" alt="">`;

/** CSS for a heading that leads with the hat. */
export const HAT_CSS = "h1.brand{{display:flex;align-items:center;gap:12px}}.hat{{image-rendering:pixelated;flex:none}}";
'''


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="render", type=Path, help="a rendered hat on a plain light background, to rebuild hat-source.png from")
    args = p.parse_args()
    BRAND.mkdir(parents=True, exist_ok=True)
    if args.render:
        clean(args.render).save(SOURCE, optimize=True)
    hat = Image.open(SOURCE).convert("RGBA")

    hat_svg = svg(hat)
    (BRAND / "hat.svg").write_text(hat_svg)
    (ROOT / "docs-site" / "src" / "assets" / "brand").mkdir(parents=True, exist_ok=True)
    (ROOT / "docs-site" / "src" / "assets" / "brand" / "hat.svg").write_text(hat_svg)
    # The small mark: 18x16 on the page, drawn at twice that.
    fit(hat, 36, 32).save(BRAND / "hat-small.png", optimize=True)
    # 160 px wide for the README: the art at 2x, centred.
    big = Image.new("RGBA", (160, 148), (0, 0, 0, 0))
    big.alpha_composite(scaled(hat, 2), ((160 - hat.width * 2) // 2, (148 - hat.height * 2) // 2))
    big.save(BRAND / "hat-160.png", optimize=True)

    (BRAND / "database.svg").write_text(svg(database({"Y": YELLOW, "B": BLUE})))
    (BRAND / "database-mono.svg").write_text(svg(database({"Y": BLUE, "B": BLUE}, mono=True)))

    (PUBLIC / "favicon.svg").write_text(favicon_svg(hat))
    tile(hat, 32, 1).save(PUBLIC / "favicon-32.png", optimize=True)
    tile(hat, 48, 2).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    social(hat).save(PUBLIC / "social-preview.png", optimize=True)
    share(hat).save(PUBLIC / "hat-share.png", optimize=True)

    (ROOT / "src" / "brand.ts").write_text(brand_ts(hat))
    print(f"hat {hat.width}x{hat.height}, {len(hat.getcolors(4096)) - 1} colours; wrote {BRAND.relative_to(ROOT)}, the favicons, the previews and src/brand.ts")


if __name__ == "__main__":
    main()
