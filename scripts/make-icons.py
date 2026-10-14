#!/usr/bin/env python3
"""Generate the RSI Tracker app icons as PNGs with no third-party deps.

Adapted from the pwa-cloudflare skill's make-icons.py. Draws an RSI line
swinging through the 70 (red) and 30 (green) bands on the app's dark
background. Fully opaque (iOS renders alpha as black), no pre-rounded corners
(iOS applies its own mask). Drawn at 4x and box-downsampled for smooth edges.

Run from the repo root:  python3 scripts/make-icons.py
"""
import math
import os
import struct
import zlib

BG    = (10, 14, 23)      # --bg #0a0e17
LINE  = (226, 232, 240)   # --text
RED   = (255, 82, 82)     # --red
GREEN = (0, 230, 118)     # --green
SS = 4                    # supersampling factor

OUT = os.environ.get('ICON_OUT', os.path.join(os.getcwd(), 'public', 'icons'))


class Canvas:
    def __init__(self, size, bg):
        self.size = size
        self.px = bytearray(bytes(bg) * (size * size))

    def rect(self, x0, y0, x1, y1, color):
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(self.size, int(x1)), min(self.size, int(y1))
        row = bytes(color) * max(0, x1 - x0)
        for y in range(y0, y1):
            start = (y * self.size + x0) * 3
            self.px[start:start + len(row)] = row

    def disc(self, cx, cy, r, color):
        for y in range(max(0, int(cy - r)), min(self.size, int(cy + r) + 1)):
            dy = y + 0.5 - cy
            if abs(dy) > r:
                continue
            dx = math.sqrt(r * r - dy * dy)
            self.rect(cx - dx, y, cx + dx, y + 1, color)

    def polyline(self, pts, width, color):
        r = width / 2
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            steps = int(math.hypot(x1 - x0, y1 - y0) / max(1.0, r / 3)) + 1
            for i in range(steps + 1):
                t = i / steps
                self.disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, color)

    def downsample(self, f):
        n = self.size // f
        out = Canvas(n, BG)
        for y in range(n):
            for x in range(n):
                acc = [0, 0, 0]
                for sy in range(f):
                    base = ((y * f + sy) * self.size + x * f) * 3
                    for sx in range(f):
                        i = base + sx * 3
                        acc[0] += self.px[i]; acc[1] += self.px[i + 1]; acc[2] += self.px[i + 2]
                o = (y * n + x) * 3
                out.px[o:o + 3] = bytes(v // (f * f) for v in acc)
        return out

    def png(self, path):
        raw = bytearray()
        stride = self.size * 3
        for y in range(self.size):
            raw.append(0)  # filter: none
            raw.extend(self.px[y * stride:(y + 1) * stride])

        def chunk(tag, data):
            out = struct.pack('>I', len(data)) + tag + data
            return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack('>IIBBBBB', self.size, self.size, 8, 2, 0, 0, 0)
        blob = (b'\x89PNG\r\n\x1a\n'
                + chunk(b'IHDR', ihdr)
                + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
                + chunk(b'IEND', b''))
        with open(path, 'wb') as f:
            f.write(blob)


def draw(size, pad_frac):
    big = size * SS
    c = Canvas(big, BG)
    pad = big * pad_frac
    inner = big - 2 * pad
    X = lambda u: pad + u * inner
    Y = lambda v: pad + v * inner

    # Threshold bands: 70 near the top, 30 near the bottom.
    band = inner * 0.035
    c.rect(X(0), Y(0.28) - band / 2, X(1), Y(0.28) + band / 2, RED)
    c.rect(X(0), Y(0.72) - band / 2, X(1), Y(0.72) + band / 2, GREEN)

    # The RSI line: up through 70, down through 30, recovering.
    pts = [(0.04, 0.55), (0.26, 0.14), (0.50, 0.62), (0.70, 0.88), (0.96, 0.36)]
    c.polyline([(X(u), Y(v)) for u, v in pts], inner * 0.085, LINE)
    # Mark the oversold trough — the buy signal the app exists for.
    c.disc(X(0.70), Y(0.88), inner * 0.075, GREEN)
    return c.downsample(SS)


os.makedirs(OUT, exist_ok=True)
# apple-touch-icon: iOS squircle-crops the corners, so keep content inset.
draw(180, 0.14).png(os.path.join(OUT, 'apple-touch-icon.png'))
draw(192, 0.12).png(os.path.join(OUT, 'icon-192.png'))
draw(512, 0.12).png(os.path.join(OUT, 'icon-512.png'))
# maskable: safe zone is the middle 80%, so pad harder.
draw(512, 0.22).png(os.path.join(OUT, 'icon-maskable-512.png'))

for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(os.path.join(OUT, f)), 'bytes')
