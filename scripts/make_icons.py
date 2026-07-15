"""Generate Flyrics extension icons (lyrics-lines mark on dark rounded square)."""
from PIL import Image, ImageDraw
import os

OUT = "./extension/icons"
os.makedirs(OUT, exist_ok=True)

BG = (9, 9, 11, 255)        # zinc-950
MUTED = (113, 113, 122, 255)  # zinc-500
ACTIVE = (250, 250, 250, 255)  # zinc-50


def make(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    radius = max(2, size // 5)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    pad = size * 0.22
    bar_h = max(1, round(size * 0.085))
    gap = (size - 2 * pad - 3 * bar_h) / 2
    x0 = pad
    y = pad

    widths = [0.62, 1.0, 0.45]
    colors = [MUTED, ACTIVE, MUTED]
    avail = size - 2 * pad
    for w, c in zip(widths, colors):
        x1 = x0 + avail * w
        d.rounded_rectangle([x0, y, x1, y + bar_h], radius=bar_h / 2, fill=c)
        y += bar_h + gap

    img.save(f"{OUT}/icon{size}.png")


for s in (16, 32, 48, 128):
    make(s)

print("icons written to", OUT)
