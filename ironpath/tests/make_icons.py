import numpy as np
from PIL import Image, ImageDraw

BG = (11, 18, 32)  # #0b1220
# gradient stops (blue -> teal -> pink)
C1 = np.array([91, 157, 255])
C2 = np.array([56, 211, 159])
C3 = np.array([244, 114, 182])

def gradient(size):
    y, x = np.mgrid[0:size, 0:size].astype(float)
    t = ((x + y) / (2 * (size - 1)))  # 0..1 diagonal
    t = np.clip(t, 0, 1)
    out = np.zeros((size, size, 3))
    m = t < 0.5
    a = (t[m] / 0.5)[:, None]
    out[m] = C1 * (1 - a) + C2 * a
    a2 = ((t[~m] - 0.5) / 0.5)[:, None]
    out[~m] = C2 * (1 - a2) + C3 * a2
    return out.astype(np.uint8)

def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def rising_line(img, size, pad, weight):
    """White fitness-curve mark with soft area fill."""
    d = ImageDraw.Draw(img, 'RGBA')
    # control points of a gently rising curve
    xs = np.linspace(pad, size - pad, 60)
    base = size - pad
    span = size - 2 * pad
    # smooth ease-in rising curve
    tt = (xs - pad) / span
    ys = base - span * (0.15 + 0.7 * (tt ** 1.6))
    pts = list(zip(xs, ys))
    # area fill
    poly = pts + [(size - pad, base), (pad, base)]
    d.polygon(poly, fill=(255, 255, 255, 46))
    # line
    d.line(pts, fill=(255, 255, 255, 235), width=weight, joint='curve')
    # end dot
    d.ellipse([xs[-1] - weight, ys[-1] - weight, xs[-1] + weight, ys[-1] + weight], fill=(255, 255, 255, 255))

def make(size, maskable=False, filename=None):
    grad = Image.fromarray(gradient(size))
    if maskable:
        canvas = grad.convert('RGB')
        rising_line(canvas, size, int(size * 0.26), max(4, size // 42))
    else:
        canvas = Image.new('RGB', (size, size), BG)
        inset = int(size * 0.10)
        tile_size = size - 2 * inset
        tile = grad.resize((tile_size, tile_size))
        mask = rounded_mask(tile_size, int(tile_size * 0.24))
        tile_rgba = tile.convert('RGBA'); tile_rgba.putalpha(mask)
        rising_line(tile_rgba, tile_size, int(tile_size * 0.20), max(4, tile_size // 38))
        canvas.paste(tile_rgba, (inset, inset), tile_rgba)
    canvas.save(filename)
    print('wrote', filename)

make(512, False, 'icons/icon-512.png')
make(192, False, 'icons/icon-192.png')
make(180, False, 'icons/icon-180.png')
make(512, True, 'icons/icon-maskable-512.png')
