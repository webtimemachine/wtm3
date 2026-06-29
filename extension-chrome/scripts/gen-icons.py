#!/usr/bin/env python3
"""Generate Web Time Machine extension icons (no external deps).
A clock face on a dark rounded square, sizes 16/48/128."""
import math
import os
import struct
import zlib

BG = (11, 16, 32, 255)        # #0b1020
FACE = (56, 189, 248, 255)     # #38bdf8 (sky)
HAND = (4, 18, 29, 255)        # #04121d (dark)
OUT = os.path.join(os.path.dirname(__file__), "..", "icons")


def png_bytes(w, h, px):
    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += px[y * w * 4:(y + 1) * w * 4]
    return (b"\x89PNG\r\n\x1a\n" +
            chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)) +
            chunk(b"IEND", b""))


def make(size):
    px = bytearray(size * size * 4)

    def setp(x, y, c):
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            px[i:i + 4] = bytes(c)

    cx = cy = (size - 1) / 2
    radius = size * 0.42
    corner = size * 0.22  # rounded-square radius

    for y in range(size):
        for x in range(size):
            # rounded-square background
            dx = max(corner - x, x - (size - 1 - corner), 0)
            dy = max(corner - y, y - (size - 1 - corner), 0)
            if math.hypot(dx, dy) <= corner:
                setp(x, y, BG)
            # clock face
            if math.hypot(x - cx, y - cy) <= radius:
                setp(x, y, FACE)

    # hands: minute -> 12 o'clock, hour -> ~4 o'clock
    thick = max(1.0, size * 0.045)

    def hand(angle_deg, length):
        a = math.radians(angle_deg)
        ex, ey = cx + math.sin(a) * length, cy - math.cos(a) * length
        steps = int(length * 3) + 2
        for s in range(steps + 1):
            t = s / steps
            px_, py_ = cx + (ex - cx) * t, cy + (ey - cy) * t
            r = int(thick)
            for oy in range(-r, r + 1):
                for ox in range(-r, r + 1):
                    if ox * ox + oy * oy <= thick * thick:
                        setp(round(px_) + ox, round(py_) + oy, HAND)

    hand(0, radius * 0.72)    # minute (up)
    hand(120, radius * 0.5)   # hour (4 o'clock)
    # center hub
    r = max(1, int(size * 0.05))
    for oy in range(-r, r + 1):
        for ox in range(-r, r + 1):
            if ox * ox + oy * oy <= r * r:
                setp(round(cx) + ox, round(cy) + oy, HAND)

    return png_bytes(size, size, px)


def main():
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 48, 128):
        path = os.path.join(OUT, f"icon{s}.png")
        with open(path, "wb") as f:
            f.write(make(s))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
