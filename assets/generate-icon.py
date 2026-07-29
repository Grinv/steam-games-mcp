#!/usr/bin/env python3
"""Regenerate assets/icon.png from the design in icon-source.svg.

Not part of the npm build — this is a one-off design asset, run manually
whenever the icon needs to change. Requires Pillow (`pip install pillow`).

Renders directly with Pillow instead of an SVG->PNG pipeline: both a
Chrome/chrome-devtools screenshot and macOS Quick Look's SVG thumbnailer
silently composite the transparent background against opaque white, which
Anthropic's MCPB icon spec explicitly requires ("PNG with transparency" -
see claude.com/docs/connectors/building/mcpb). Drawing directly gives real
per-pixel alpha with no compositing step to lose it.

Keep the geometry/colors here in sync with icon-source.svg by hand if you
ever edit one — there's no automated link between the two.

Gradient stops are Valve's own real Steam logo gradient, pulled directly
from their official SVG asset
(upload.wikimedia.org/wikipedia/commons/8/83/Steam_icon_logo.svg, the
<linearGradient id="A"> behind their "eye" mark) — not approximated from a
page-background sample. The foreground (D-pad + buttons) is plain white,
matching how the real logo puts a solid white mark over that same gradient.
Shape is a literal (but simplified/original) gamepad silhouette — a rounded,
near-square capsule body with a D-pad cross on the left and two action
buttons on the right — not Steam's own logo mark (their actual "eye"
glyph); gradient/color association only.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icon.png"

SIZE = 512
SCALE = 4  # supersample then downsample for anti-aliased edges (Pillow's
           # ImageDraw has no native AA)

# Valve's own gradient, top to bottom, verified against the live SVG asset
# above (7 stops, not simplified — matching the real file exactly).
STOPS = [
    (0.0, (0x11, 0x1D, 0x2E)),
    (0.212, (0x05, 0x18, 0x39)),
    (0.407, (0x0A, 0x1B, 0x48)),
    (0.581, (0x13, 0x2E, 0x62)),
    (0.738, (0x14, 0x4B, 0x7E)),
    (0.873, (0x13, 0x64, 0x97)),
    (1.0, (0x13, 0x87, 0xB8)),
]
WHITE = (0xFF, 0xFF, 0xFF)

# All geometry in final 512x512 units; multiplied by SCALE at draw time.
# A near-square body (380x260, ~1.46:1) rather than an elongated pill.
BODY_BOX = (66, 126, 446, 386)

DPAD_CENTER = (180, 256)
DPAD_ARM_LEN = 116  # full span of each arm (tip to tip through center)
DPAD_THICK = 48

BTN_CENTERS = [(332, 220), (376, 286)]  # diagonal 2-button layout
BTN_RADIUS = 32


def lerp_color(t, stops):
    for i in range(len(stops) - 1):
        t0, c0 = stops[i]
        t1, c1 = stops[i + 1]
        if t0 <= t <= t1 or i == len(stops) - 2:
            local_t = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            local_t = max(0.0, min(1.0, local_t))
            return tuple(round(c0[ch] + (c1[ch] - c0[ch]) * local_t) for ch in range(3))
    return stops[-1][1]


def main():
    w = h = SIZE * SCALE

    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    bx0, by0, bx1, by1 = (v * SCALE for v in BODY_BOX)
    radius = (by1 - by0) / 2
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=radius, fill=255)

    # vertical gradient, scoped to the body's own bounding box — matches
    # icon-source.svg's gradient units (y1=0/y2=1 relative to the shape).
    x0, y0, x1, y1 = mask.getbbox()
    grad = Image.new("RGB", (w, h))
    gpix = grad.load()
    span = max(1, y1 - y0)
    row_colors = {y: lerp_color((y - y0) / span, STOPS) for y in range(y0, y1)}
    for y in range(y0, y1):
        col = row_colors[y]
        for x in range(x0, x1):
            gpix[x, y] = col

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d2 = ImageDraw.Draw(img)
    cx, cy = DPAD_CENTER
    cx, cy = cx * SCALE, cy * SCALE
    half_len = (DPAD_ARM_LEN / 2) * SCALE
    half_thick = (DPAD_THICK / 2) * SCALE
    d2.rounded_rectangle(
        [cx - half_len, cy - half_thick, cx + half_len, cy + half_thick],
        radius=half_thick * 0.3,
        fill=(*WHITE, 255),
    )
    d2.rounded_rectangle(
        [cx - half_thick, cy - half_len, cx + half_thick, cy + half_len],
        radius=half_thick * 0.3,
        fill=(*WHITE, 255),
    )

    r = BTN_RADIUS * SCALE
    for bx, by in BTN_CENTERS:
        bx, by = bx * SCALE, by * SCALE
        d2.ellipse([bx - r, by - r, bx + r, by + r], fill=(*WHITE, 255))

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
