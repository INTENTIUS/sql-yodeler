#!/usr/bin/env python3
"""SQL Yodeler's brand assets: the hat, in every size the site, the README
and yodel's pages use, and the boot, the site's small mark.

    python3 scripts/brand.py                 # every asset, from docs-site/public/brand/hat-source.png
    python3 scripts/brand.py --from art.png  # first rebuild hat-source.png from a rendered hat

hat-source.png is the hat as rendered: the 1024x1024 render with its plain
background taken out and cropped to the hat. The edge keeps the render's own
anti-aliasing (alpha ramps over a band of colour distance from the
background), and a 3x3 minimum filter on the alpha takes off the light fringe
the background leaves; the result is kept at 672 px tall. Every size of the
hat is that image resampled once, smoothly, so it looks the same at every size.

The boot is pixel art drawn from the grid below, one SVG square per art pixel,
shown with image-rendering: pixelated.

The script overwrites every file it writes. Needs Python 3 with Pillow and NumPy.
"""

import argparse
import base64
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "docs-site" / "public"
BRAND = PUBLIC / "brand"
SOURCE = BRAND / "hat-source.png"

# ---------------------------------------------------------------- the hat


def clean(render: Path) -> Image.Image:
    """The rendered hat with its background taken out, cropped to the hat."""
    a = np.asarray(Image.open(render).convert("RGB")).astype(float)
    edge = np.concatenate([a[:8].reshape(-1, 3), a[-8:].reshape(-1, 3), a[:, :8].reshape(-1, 3), a[:, -8:].reshape(-1, 3)])
    bg = np.median(edge, axis=0)
    distance = np.abs(a - bg).sum(2)
    alpha = np.clip((distance - 40) / 70, 0, 1)
    mask = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))
    hat = Image.fromarray(a.astype(np.uint8)).convert("RGBA")
    hat.putalpha(mask)
    # Kept at 672 px tall, twice the largest size the site draws.
    return height(hat.crop(hat.getbbox()), 672)


def height(img: Image.Image, h: int) -> Image.Image:
    """The image resampled once to h pixels tall."""
    return img.resize((round(img.width * h / img.height), h), Image.LANCZOS)


# ---------------------------------------------------------------- the boot

# 23x21: a cowboy boot, toe to the right, with a lone star on the shaft and a
# spur at the heel, in the hat's leather. O outline, H L M D the leather from
# light to dark, S the heel, Y the star and the spur.
BOOT = """
....OO.....OO..........
...OHLO...OLDO.........
...OHLMO.OMMDO.........
...OHLMMOMMMDO.........
...OHLMMMMMMDO.........
...OHLMMYMMMDO.........
...OHLMYYYMMDO.........
...OHLYYYYYMDO.........
...OHLMYYYMMDO.........
...OHLMYMYMMDO.........
...OHLMMMMMMDO.........
...ODDDDDDDDDO.........
...OHLMMMMMMMDOO.......
...OHLMMMMMMMMMDOO.....
...OHLLMMMMMMMMMMDDOO..
...OHLLLLLLLLLLLLLLLMOO
...ODDDDDDDDDDDDDDDDDDO
...OSSSSOOOOOOOOOOOOOO.
.Y.OSSSSO..............
YYYYOSSSO..............
.Y..OOOO...............
"""
LEATHER = {"O": "#17111a", "H": "#ecb56e", "L": "#bd773f", "M": "#96542b", "D": "#643018", "S": "#3f1e14", "Y": "#f7d136"}


def boot() -> Image.Image:
    rows = BOOT.strip("\n").split("\n")
    img = Image.new("RGBA", (max(map(len, rows)), len(rows)), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in LEATHER:
                img.putpixel((x, y), hex_rgba(LEATHER[ch]))
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
    """1280x640: the hat beside the wordmark and the tagline, on the site's dark ground."""
    out = Image.new("RGB", (1280, 640), (12, 10, 9))
    art = height(hat, 340)
    out.paste(art, (100, (640 - art.height) // 2), art)
    d = ImageDraw.Draw(out)
    title, body = font(84, True), font(34, False)
    tagline = "Schema management and migrations for ClickHouse and Postgres."
    lines = wrap(d, tagline, body, 640)
    x, line_h = 520, 46
    top = (640 - (100 + 24 + line_h * len(lines))) // 2
    d.text((x, top), "SQL Yodeler", font=title, fill=(250, 247, 242))
    for i, line in enumerate(lines):
        d.text((x, top + 124 + i * line_h), line, font=body, fill=(168, 160, 150))
    return out


def share(hat: Image.Image) -> Image.Image:
    """400x400: the hat centred on the site's dark ground, the square a shared link shows."""
    out = Image.new("RGB", (400, 400), (12, 10, 9))
    art = fit(hat, 320, 320)
    out.paste(art, ((400 - art.width) // 2, (400 - art.height) // 2), art)
    return out


def favicon_svg(hat: Image.Image) -> str:
    """The hat on a rounded tile, white in a light browser theme and black in a dark one."""
    uri = "data:image/png;base64," + base64.b64encode(png_bytes(fit(hat, 56, 56))).decode()
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64" width="64" height="64">'
        '<style>.g{fill:#fff}@media (prefers-color-scheme:dark){.g{fill:#000}}</style>'
        f'<rect class="g" width="64" height="64" rx="11"/><image x="4" y="4" width="56" height="56" href="{uri}"/></svg>\n'
    )


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def brand_ts(hat: Image.Image) -> str:
    # 48 px tall on the page, drawn at twice that.
    art = height(hat, 96)
    uri = "data:image/png;base64," + base64.b64encode(png_bytes(art)).decode()
    w, h = round(art.width / 2), 48
    return f'''// Written by scripts/brand.py; run it again rather than editing this file.

/**
 * SQL Yodeler's logo, the hat, for the pages yodel writes (yodel report --html
 * and yodel docs). It is inlined as a PNG data URI, drawn at twice the size it
 * is shown, so each page stays one self-contained file.
 */
export const HAT_PNG = "{uri}";

/** The favicon link a page's head carries. */
export const HAT_ICON = `<link rel="icon" type="image/png" href="${{HAT_PNG}}">`;

/** The hat beside a page's heading; decorative, since the heading names the page. */
export const HAT_IMG = `<img class="hat" src="${{HAT_PNG}}" width="{w}" height="{h}" alt="">`;

/** CSS for a heading that leads with the hat. */
export const HAT_CSS = "h1.brand{{display:flex;align-items:center;gap:12px}}.hat{{flex:none}}";
'''


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--from", dest="render", type=Path, help="a rendered hat on a plain light background, to rebuild hat-source.png from")
    args = p.parse_args()
    BRAND.mkdir(parents=True, exist_ok=True)
    if args.render:
        clean(args.render).save(SOURCE, optimize=True)
    hat = Image.open(SOURCE).convert("RGBA")

    # The header logo (Starlight serves it at 40 px tall) and the home page's hat
    # (up to 168 px tall), each drawn at twice the size shown.
    assets = ROOT / "docs-site" / "src" / "assets" / "brand"
    assets.mkdir(parents=True, exist_ok=True)
    height(hat, 96).save(assets / "hat.png", optimize=True)
    height(hat, 336).save(BRAND / "hat.png", optimize=True)
    # The small mark: about 22x20 on the page, drawn at twice that.
    fit(hat, 44, 40).save(BRAND / "hat-small.png", optimize=True)
    # 160 px wide for the README.
    fit(hat, 160, 148).save(BRAND / "hat-160.png", optimize=True)


    (BRAND / "boot.svg").write_text(svg(boot()))

    (PUBLIC / "favicon.svg").write_text(favicon_svg(hat))
    tile(hat, 32, 1).save(PUBLIC / "favicon-32.png", optimize=True)
    tile(hat, 48, 2).save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    social(hat).save(PUBLIC / "social-preview.png", optimize=True)
    share(hat).save(PUBLIC / "hat-share.png", optimize=True)

    (ROOT / "src" / "brand.ts").write_text(brand_ts(hat))
    print(f"hat {hat.width}x{hat.height}; wrote {BRAND.relative_to(ROOT)}, the header logo, the favicons, the previews and src/brand.ts")


if __name__ == "__main__":
    main()
