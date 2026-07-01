#!/usr/bin/env python3
"""Generate the opaque 1024x1024 Web Time Machine icon (no alpha — required for
the App Store icon and the iOS home-screen icon). Full-bleed dark square with a
sky-blue clock; iOS/App Store apply the rounded-rect mask themselves."""
import math
import struct
import sys
import zlib

BG = (11, 16, 32)       # #0b1020
FACE = (56, 189, 248)   # #38bdf8
HAND = (4, 18, 29)      # #04121d
SIZE = 1024


def png_rgb(w, h, px):
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * w * 3:(y + 1) * w * 3]
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) +  # color type 2 = RGB, no alpha
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) +
            chunk(b"IEND", b""))


def make(size):
    px = bytearray()
    for _ in range(size * size):
        px += bytes(BG)

    def setp(x, y, c):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 3
            px[i:i + 3] = bytes(c)

    cx = cy = (size - 1) / 2
    radius = size * 0.40
    for y in range(size):
        for x in range(size):
            if math.hypot(x - cx, y - cy) <= radius:
                setp(x, y, FACE)

    thick = size * 0.035

    def hand(angle_deg, length):
        a = math.radians(angle_deg)
        ex, ey = cx + math.sin(a) * length, cy - math.cos(a) * length
        steps = int(length * 2) + 2
        for s in range(steps + 1):
            t = s / steps
            pxq, pyq = cx + (ex - cx) * t, cy + (ey - cy) * t
            r = int(thick)
            for oy in range(-r, r + 1):
                for ox in range(-r, r + 1):
                    if ox * ox + oy * oy <= thick * thick:
                        setp(round(pxq) + ox, round(pyq) + oy, HAND)

    hand(0, radius * 0.72)    # minute hand (12 o'clock)
    hand(120, radius * 0.5)   # hour hand (~4 o'clock)
    r = int(size * 0.045)
    for oy in range(-r, r + 1):
        for ox in range(-r, r + 1):
            if ox * ox + oy * oy <= r * r:
                setp(round(cx) + ox, round(cy) + oy, HAND)

    return png_rgb(size, size, px)


def main():
    data = make(SIZE)
    for path in sys.argv[1:]:
        with open(path, "wb") as f:
            f.write(data)
        print("wrote", path)


if __name__ == "__main__":
    main()
