#!/usr/bin/env python3
"""Keep only a chosen set of animations in a .glb, dropping the rest.

VRChat/VRCFury exports can bake in hundreds of animation clips (every
gesture/emote/locomotion state reachable from the Animator), most of which
are never used by the web viewer and bloat the file substantially, since
each clip owns its own accessors/bufferViews/buffer bytes. This script
rewrites the glb keeping only animations whose name is in --keep, and drops
every accessor/bufferView/byte range that only those removed animations
referenced.

Usage:
    python3 tools/filter_animations.py input.glb output.glb --keep "Idle" "Sitting"
    python3 tools/filter_animations.py input.glb output.glb --keep-file poses.txt

--keep-file expects one animation name per line.

Only meshes/materials/skeleton/etc. are left completely untouched — this
only ever removes animations and the binary data they alone used.
"""

import argparse

from glb_common import read_glb, write_glb, filter_animations


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Source .glb file")
    parser.add_argument("output", help="Destination .glb file")
    parser.add_argument("--keep", nargs="*", default=[], help="Animation names to keep")
    parser.add_argument("--keep-file", help="Text file with one animation name to keep per line")
    args = parser.parse_args()

    keep_names = set(args.keep)
    if args.keep_file:
        with open(args.keep_file, "r", encoding="utf-8") as f:
            keep_names |= {line.strip() for line in f if line.strip()}

    if not keep_names:
        parser.error("no animation names given via --keep or --keep-file")

    gltf, bin_data = read_glb(args.input)
    total_before = len(gltf.get("animations", []))

    gltf, new_bin = filter_animations(gltf, bin_data, keep_names)

    write_glb(args.output, gltf, new_bin)

    print(f"Kept {len(gltf['animations'])}/{total_before} animations.")
    print(f"Buffer size: {len(bin_data):,} -> {len(new_bin):,} bytes")


if __name__ == "__main__":
    main()
