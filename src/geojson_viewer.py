#!/usr/bin/env python3
"""
geojson_viewer.py — Fast GeoJSON visualizer for large files (1-2 GB+)

Streams the file instead of loading it all into memory, with optional
random sampling so even multi-GB files render in seconds.

Usage:
    python geojson_viewer.py <file.geojson> [options]

Options:
    --max N        Max features to render (default: 50000)
    --no-sample    Render ALL features (slow on huge files)
    --out FILE     Save PNG instead of opening a window
    --no-basemap   Skip downloading a basemap tile background
    --color COLOR  Feature color (default: steelblue)
    --alpha A      Opacity 0-1 (default: 0.5)
    --linewidth W  Line width (default: 0.4)
    --figsize WxH  Figure size in inches, e.g. 14x10 (default: 14x10)

Examples:
    python geojson_viewer.py parcels.geojson
    python geojson_viewer.py roads.geojson --max 100000 --color tomato
    python geojson_viewer.py big.geojson --out preview.png --no-basemap
"""

import sys
import os
import argparse
import time
import random
import math
import json

# ---------------------------------------------------------------------------
# Dependency check — friendly error before anything else
# ---------------------------------------------------------------------------
REQUIRED = {
    "ijson":      "pip install ijson",
    "matplotlib": "pip install matplotlib",
    "shapely":    "pip install shapely",
}
OPTIONAL = {
    "contextily": "pip install contextily",
    "tqdm":       "pip install tqdm",
}

missing_required = []
for pkg, install in REQUIRED.items():
    try:
        __import__(pkg)
    except ImportError:
        missing_required.append(f"  {pkg:12s}  →  {install}")

if missing_required:
    print("ERROR: Missing required packages. Install them first:\n")
    print("\n".join(missing_required))
    sys.exit(1)

import ijson
import matplotlib
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.collections as mc
from matplotlib.patches import Polygon as MplPolygon
from matplotlib.collections import PatchCollection, LineCollection
from shapely.geometry import shape, mapping
from shapely.geometry.base import BaseGeometry

try:
    import contextily as cx
    HAS_CONTEXTILY = True
except ImportError:
    HAS_CONTEXTILY = False

try:
    from tqdm import tqdm
    HAS_TQDM = True
except ImportError:
    HAS_TQDM = False


# ---------------------------------------------------------------------------
# Streaming parser
# ---------------------------------------------------------------------------

def stream_features(path: str, max_features: int | None, seed: int = 42):
    """
    Stream features from a GeoJSON file without loading it all into memory.

    Strategy:
      - First pass (fast): count total features via ijson
      - If sampling: compute a skip probability so we collect ~max_features
        uniformly across the file
    """
    file_size = os.path.getsize(path)
    print(f"File size : {file_size / 1e6:.1f} MB")

    # ---- quick count pass (reads only 'type' keys, very fast) -------------
    if max_features is not None:
        print("Counting features (fast pass)…", end=" ", flush=True)
        t0 = time.time()
        total = 0
        with open(path, "rb") as f:
            for _ in ijson.items(f, "features.item.type"):
                total += 1
        print(f"{total:,} features found in {time.time()-t0:.1f}s")
        keep_prob = min(1.0, max_features / max(total, 1))
        print(f"Sampling  : {keep_prob*100:.1f}%  ({min(total, max_features):,} features)")
    else:
        total = None
        keep_prob = 1.0
        print("Sampling  : disabled (rendering ALL features)")

    # ---- main extraction pass ---------------------------------------------
    rng = random.Random(seed)
    features = []
    skipped = 0

    iterator = _iter_features(path)
    if HAS_TQDM and total:
        iterator = tqdm(iterator, total=total, unit="feat", desc="Loading")

    for feat in iterator:
        if rng.random() > keep_prob:
            skipped += 1
            continue
        geom = feat.get("geometry")
        if geom is None:
            continue
        try:
            features.append(shape(geom))
        except Exception:
            continue

    print(f"Loaded    : {len(features):,} geometries  (skipped {skipped:,})")
    return features


def _iter_features(path: str):
    """Yield raw feature dicts from a GeoJSON FeatureCollection."""
    with open(path, "rb") as f:
        yield from ijson.items(f, "features.item")


# ---------------------------------------------------------------------------
# Geometry → matplotlib collections
# ---------------------------------------------------------------------------

POLY_TYPES  = {"Polygon", "MultiPolygon"}
LINE_TYPES  = {"LineString", "MultiLineString"}
POINT_TYPES = {"Point", "MultiPoint"}

def _geom_type(g: BaseGeometry) -> str:
    return g.geom_type


def split_by_type(geoms):
    polys, lines, points = [], [], []
    for g in geoms:
        t = g.geom_type
        if t in POLY_TYPES:
            polys.append(g)
        elif t in LINE_TYPES:
            lines.append(g)
        elif t in POINT_TYPES:
            points.append(g)
        # GeometryCollection: recurse
        elif t == "GeometryCollection":
            p2, l2, pt2 = split_by_type(list(g.geoms))
            polys.extend(p2); lines.extend(l2); points.extend(pt2)
    return polys, lines, points


def polygons_to_patches(polys):
    patches = []
    for g in polys:
        parts = [g] if g.geom_type == "Polygon" else list(g.geoms)
        for part in parts:
            coords = list(part.exterior.coords)
            patches.append(MplPolygon(coords, closed=True))
    return patches


def lines_to_segments(lines):
    segs = []
    for g in lines:
        parts = [g] if g.geom_type == "LineString" else list(g.geoms)
        for part in parts:
            coords = list(part.coords)
            segs.append(coords)
    return segs


def points_to_xy(points):
    xs, ys = [], []
    for g in points:
        pts = [g] if g.geom_type == "Point" else list(g.geoms)
        for p in pts:
            xs.append(p.x); ys.append(p.y)
    return xs, ys


# ---------------------------------------------------------------------------
# Bounds helper
# ---------------------------------------------------------------------------

def compute_bounds(geoms):
    min_x = min_y =  math.inf
    max_x = max_y = -math.inf
    for g in geoms:
        b = g.bounds  # (minx, miny, maxx, maxy)
        min_x = min(min_x, b[0]); min_y = min(min_y, b[1])
        max_x = max(max_x, b[2]); max_y = max(max_y, b[3])
    return min_x, min_y, max_x, max_y


# ---------------------------------------------------------------------------
# Main render
# ---------------------------------------------------------------------------

def render(geoms, args):
    t0 = time.time()

    fw, fh = map(int, args.figsize.split("x"))
    fig, ax = plt.subplots(figsize=(fw, fh), facecolor="#1a1a2e")
    ax.set_facecolor("#1a1a2e")
    ax.set_aspect("equal")

    color  = args.color
    alpha  = args.alpha
    lw     = args.linewidth

    polys, lines, points = split_by_type(geoms)
    print(f"Geometry  : {len(polys):,} poly | {len(lines):,} line | {len(points):,} point")

    legend_handles = []

    # --- polygons ---
    if polys:
        patches = polygons_to_patches(polys)
        pc = PatchCollection(patches, facecolor=color, edgecolor=color,
                             linewidth=lw * 0.5, alpha=alpha)
        ax.add_collection(pc)
        legend_handles.append(mpatches.Patch(color=color, label=f"Polygons ({len(polys):,})"))

    # --- lines ---
    if lines:
        segs = lines_to_segments(lines)
        lc = LineCollection(segs, colors=color, linewidths=lw, alpha=alpha)
        ax.add_collection(lc)
        legend_handles.append(mpatches.Patch(color=color, label=f"Lines ({len(lines):,})"))

    # --- points ---
    if points:
        xs, ys = points_to_xy(points)
        ax.scatter(xs, ys, s=1.5, c=color, alpha=min(alpha + 0.2, 1.0),
                   linewidths=0, rasterized=True)
        legend_handles.append(mpatches.Patch(color=color, label=f"Points ({len(points):,})"))

    # auto-limits
    if geoms:
        minx, miny, maxx, maxy = compute_bounds(geoms)
        pad_x = (maxx - minx) * 0.02 or 0.01
        pad_y = (maxy - miny) * 0.02 or 0.01
        ax.set_xlim(minx - pad_x, maxx + pad_x)
        ax.set_ylim(miny - pad_y, maxy + pad_y)

    # --- optional basemap ---
    if not args.no_basemap and HAS_CONTEXTILY:
        try:
            print("Fetching basemap tiles…")
            cx.add_basemap(ax, crs="EPSG:4326",
                           source=cx.providers.CartoDB.DarkMatter,
                           zoom="auto")
        except Exception as e:
            print(f"  Basemap skipped ({e})")
    elif not args.no_basemap and not HAS_CONTEXTILY:
        print("  Basemap skipped (contextily not installed — pip install contextily)")

    # --- labels ---
    fname = os.path.basename(args.file)
    sampled = f"  [sampled {len(geoms):,} / shown]" if args.max else ""
    ax.set_title(f"{fname}{sampled}", color="white", fontsize=11, pad=8)
    ax.tick_params(colors="#888888", labelsize=7)
    for spine in ax.spines.values():
        spine.set_edgecolor("#333355")

    if legend_handles:
        ax.legend(handles=legend_handles, loc="lower right",
                  facecolor="#0d0d1a", edgecolor="#333355",
                  labelcolor="white", fontsize=8)

    plt.tight_layout()
    print(f"Render    : {time.time()-t0:.2f}s")

    if args.out:
        fig.savefig(args.out, dpi=150, bbox_inches="tight",
                    facecolor=fig.get_facecolor())
        print(f"Saved     : {args.out}")
    else:
        plt.show()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args():
    p = argparse.ArgumentParser(
        description="Fast streaming GeoJSON visualizer for large files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("Usage:")[1] if "Usage:" in __doc__ else ""
    )
    p.add_argument("file",           help="Path to .geojson file")
    p.add_argument("--max",          type=int, default=50_000,
                   metavar="N",      help="Max features to render (default: 50000)")
    p.add_argument("--no-sample",    action="store_true",
                                     help="Render ALL features (may be slow)")
    p.add_argument("--out",          metavar="FILE",
                                     help="Save PNG to this path instead of opening a window")
    p.add_argument("--no-basemap",   action="store_true",
                                     help="Skip basemap download")
    p.add_argument("--color",        default="steelblue",
                                     help="Feature color (default: steelblue)")
    p.add_argument("--alpha",        type=float, default=0.5,
                                     help="Opacity 0-1 (default: 0.5)")
    p.add_argument("--linewidth",    type=float, default=0.4,
                                     help="Line width (default: 0.4)")
    p.add_argument("--figsize",      default="14x10",
                                     help="Figure size WxH in inches (default: 14x10)")
    return p.parse_args()


def main():
    args = parse_args()

    if not os.path.isfile(args.file):
        print(f"ERROR: File not found: {args.file}")
        sys.exit(1)

    max_features = None if args.no_sample else args.max

    print(f"\n{'='*50}")
    print(f"  GeoJSON Viewer")
    print(f"{'='*50}")
    print(f"File      : {args.file}")

    t_total = time.time()
    geoms = stream_features(args.file, max_features)

    if not geoms:
        print("No renderable geometries found.")
        sys.exit(1)

    render(geoms, args)
    print(f"Total     : {time.time()-t_total:.2f}s")
    print(f"{'='*50}\n")


if __name__ == "__main__":
    main()