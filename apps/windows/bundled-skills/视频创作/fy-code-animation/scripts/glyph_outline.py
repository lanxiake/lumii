#!/usr/bin/env python3
"""Export one glyph's outline for the GlyphAnatomy specimen (style-pack-03).

Usage:
  python3 glyph_outline.py HeptaSlab.woff2 a out.json [--wght 400]

Writes JSON: {char, font, upm, ascender, descender, xHeight, capHeight, advance, d, contours: [[[x, y, on], ...]]}
in font units (y up). `d` is an SVG path in the same units; the component flips y.
Variable fonts are instanced at --wght first. Needs fontTools (pip install fonttools brotli).
"""
import argparse
import json

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("font")
    ap.add_argument("char")
    ap.add_argument("out")
    ap.add_argument("--wght", type=float, default=400)
    a = ap.parse_args()

    font = TTFont(a.font)
    if "fvar" in font:
        from fontTools.varLib import instancer

        font = instancer.instantiateVariableFont(font, {"wght": a.wght})
    gname = font.getBestCmap()[ord(a.char)]
    gs = font.getGlyphSet()
    svg = SVGPathPen(gs)
    gs[gname].draw(svg)

    contours = []
    if "glyf" in font:
        glyf = font["glyf"]
        g = glyf[gname]
        coords, ends, flags = g.getCoordinates(glyf)
        start = 0
        for end in ends:
            contours.append([[int(coords[i][0]), int(coords[i][1]), int(flags[i] & 1)] for i in range(start, end + 1)])
            start = end + 1
    else:  # CFF: record on-curve and control points from the drawing commands
        rec = DecomposingRecordingPen(gs)
        gs[gname].draw(rec)
        cur = []
        for op, pts in rec.value:
            if op == "moveTo":
                cur = [[*map(int, pts[0]), 1]]
            elif op in ("lineTo", "curveTo", "qCurveTo"):
                cur += [[*map(int, p), 0] for p in pts[:-1]] + [[*map(int, pts[-1]), 1]]
            elif op in ("closePath", "endPath") and cur:
                contours.append(cur)
                cur = []

    os2 = font["OS/2"]
    hhea = font["hhea"]
    data = {
        "char": a.char,
        "font": font["name"].getDebugName(1),
        "upm": font["head"].unitsPerEm,
        "ascender": hhea.ascent,
        "descender": hhea.descent,
        "xHeight": getattr(os2, "sxHeight", 0),
        "capHeight": getattr(os2, "sCapHeight", 0),
        "advance": font["hmtx"][gname][0],
        "d": svg.getCommands(),
        "contours": contours,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(data, f)
    pts = sum(len(c) for c in contours)
    print(f"{a.out}: '{a.char}' {data['font']} wght {a.wght:g} · {len(contours)} contours · {pts} points · upm {data['upm']}")


if __name__ == "__main__":
    main()
