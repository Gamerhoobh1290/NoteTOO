"""Draws the NoteTOO app icon (build/icon.png, build/icon.ico). Run: python scripts/make-icon.py

A page with a folded corner on the app's accent blue, with a yellow area highlight (the app's
signature annotation) over lines of text. Drawn at 1024 px and downsampled for each icon size.
"""
from pathlib import Path
from PIL import Image, ImageDraw

S = 1024
ACCENT = (47, 98, 214)      # --accent
ACCENT_DEEP = (34, 72, 168)
PAGE = (255, 255, 255)
FOLD = (214, 224, 246)
LINE = (186, 198, 226)
HIGHLIGHT = (255, 205, 40)  # --c-yellow family

def draw() -> Image.Image:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Tile with a soft vertical shade (lighter at the top, like Fluent app icons).
    tile = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(tile)
    for y in range(S):
        t = y / S
        c = tuple(round(a + (b - a) * t) for a, b in zip(ACCENT, ACCENT_DEEP))
        td.line([(0, y), (S, y)], fill=c + (255,))
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    img.paste(tile, (0, 0), mask)

    # Page with a folded top-right corner.
    l, t, r, b, f = 262, 190, 762, 834, 150
    shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(l + 10, t + 26), (r - f + 10, t + 26), (r + 10, t + f + 26), (r + 10, b + 26), (l + 10, b + 26)], fill=(10, 25, 70, 90))
    img = Image.alpha_composite(img, shadow)
    d = ImageDraw.Draw(img)
    d.polygon([(l, t), (r - f, t), (r, t + f), (r, b), (l, b)], fill=PAGE)
    d.polygon([(r - f, t), (r - f, t + f), (r, t + f)], fill=FOLD)

    # Text lines, with a highlight box over two of them.
    x0, x1 = l + 70, r - 70
    d.rounded_rectangle([x0 - 26, 470, x1 + 26, 640], radius=26, fill=HIGHLIGHT)
    for y, end in [(360, x1 - 120), (420, x1 - 40), (520, x1), (590, x1 - 90), (700, x1 - 30), (760, x1 - 160)]:
        d.rounded_rectangle([x0, y - 16, end, y + 16], radius=16, fill=(60, 72, 110) if 470 < y < 640 else LINE)
    return img

def main() -> None:
    out = Path(__file__).resolve().parent.parent / 'build'
    out.mkdir(exist_ok=True)
    big = draw()
    big.resize((512, 512), Image.LANCZOS).save(out / 'icon.png')
    sizes = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    big.resize((256, 256), Image.LANCZOS).save(out / 'icon.ico', sizes=[(s, s) for s in sizes])
    print('wrote', out / 'icon.png', out / 'icon.ico')

if __name__ == '__main__':
    main()
