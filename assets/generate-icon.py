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
Shape is a literal (simplified/original) gamepad silhouette — a rounded
capsule body with a D-pad cross on the left and two action buttons on the
right — not Steam's own logo mark; color association only.
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
BODY_BOX = (56, 176, 456, 336)  # capsule body — radius = height/2

DPAD_CENTER = (166, 256)
DPAD_ARM_LEN = 110  # full span of each arm (tip to tip through center)
DPAD_THICK = 46

BTN_CENTERS = [(360, 224), (400, 276)]  # diagonal 2-button layout
BTN_RADIUS = 30


def main():
    w = h = SIZE * SCALE
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    bx0, by0, bx1, by1 = (v * SCALE for v in BODY_BOX)
    radius = (by1 - by0) / 2
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=radius, fill=(*PILL_BLUE, 255))

    cx, cy = DPAD_CENTER
    cx, cy = cx * SCALE, cy * SCALE
    half_len = (DPAD_ARM_LEN / 2) * SCALE
    half_thick = (DPAD_THICK / 2) * SCALE
    d.rounded_rectangle(
        [cx - half_len, cy - half_thick, cx + half_len, cy + half_thick],
        radius=half_thick * 0.3,
        fill=(*DOT_NAVY, 255),
    )
    d.rounded_rectangle(
        [cx - half_thick, cy - half_len, cx + half_thick, cy + half_len],
        radius=half_thick * 0.3,
        fill=(*DOT_NAVY, 255),
    )

    r = BTN_RADIUS * SCALE
    for bx, by in BTN_CENTERS:
        bx, by = bx * SCALE, by * SCALE
        d.ellipse([bx - r, by - r, bx + r, by + r], fill=(*DOT_NAVY, 255))

    out = img.resize((SIZE, SIZE), Image.LANCZOS)
    out.save(OUT)
    print(f"wrote {OUT} ({out.size[0]}x{out.size[1]}, mode={out.mode})")


if __name__ == "__main__":
    main()
