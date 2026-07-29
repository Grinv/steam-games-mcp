#!/usr/bin/env python3
"""Regenerate assets/icon.png from the design in icon-source.svg.

Not part of the npm build — this is a one-off design asset, run manually
whenever the icon needs to change. Requires Pillow (`pip install pillow`).

Renders directly with Pillow instead of an SVG->PNG pipeline: both a
Chrome/chrome-devtools screenshot and macOS Quick Look's SVG thumbnailer
silently composite the transparent background against opaque white,
which Anthropic's MCPB icon spec explicitly requires ("PNG with
transparency" - see claude.com/docs/connectors/building/mcpb). Drawing
directly gives real per-pixel alpha with no compositing step to lose it.

Keep the geometry/colors here in sync with icon-source.svg by hand if you
ever edit one — there's no automated link between the two.

Colors are measured from Steam's own live site/assets, not guessed:
  - PILL_BLUE  #67C1F5 — getComputedStyle background-color sampled on
    store.steampowered.com (rgb(103, 193, 245)), Steam's familiar light-blue
    accent (close to the commonly-cited "Steam blue" #66C0F4).
  - DOT_NAVY   #071937 — most frequent non-transparent pixel color in
    store.steampowered.com/favicon.ico (Steam's own logo mark ink), a dark
    blue-black consistent with the site's body background (measured
    rgb(15, 25, 36) = #0F1923).
Shape is an original abstraction (a rounded pill + two dots, evoking a
gamepad/joystick pair), not Steam's own logo mark — color association only.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).parent / "icon.png"

SIZE = 512
SCALE = 4  # supersample then downsample for anti-aliased edges (Pillow's
           # ImageDraw has no native AA)

PILL_BLUE = (0x67, 0xC1, 0xF5)
DOT_NAVY = (0x07, 0x19, 0x37)

# All geometry in final 512x512 units; multiplied by SCALE at draw time.
PILL_BOX = (66, 171, 446, 341)  # left, top, right, bottom — radius = height/2
DOT_CENTERS = [(176, 256), (336, 256)]
DOT_RADIUS = 46


def main():
    w = h = SIZE * SCALE
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    px0, py0, px1, py1 = (v * SCALE for v in PILL_BOX)
    radius = (py1 - py0) / 2
    d.rounded_rectangle([px0, py0, px1, py1], radius=radius, fill=(*PILL_BLUE, 255))

    r = DOT_RADIUS * SCALE
    for cx, cy in DOT_CENTERS:
        cx, cy = cx * SCALE, cy * SCALE
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(*DOT_NAVY, 255))

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
