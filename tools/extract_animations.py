#!/usr/bin/env python3
"""Extract selected animation clips from a .glb into a standalone JSON file.

This decouples animation authoring from visual re-exports: export a glb with
your poses once, extract them here into a small node-name-keyed JSON file,
then use merge_animations.py to combine that with any later visuals-only
glb re-export (mesh/material changes) without re-touching the animations.

Channels are stored keyed by the target node's full scene PATH (e.g.
"Novabeast_lilToon/clothing/shirt") rather than its index, since a separate
visuals-only export will have its own (likely different) node ordering —
merge_animations.py looks nodes up by path to reattach them. Bare names
alone aren't reliably unique in these exports: VRCFury adds a parallel
"menu" preview hierarchy that reuses names like "shirt"/"skeleton" from the
real mesh/skeleton tree, so the full ancestor path is what disambiguates.

Usage:
    python3 tools/extract_animations.py novabeast.glb animations.json --keep "Idle" "Sitting"
    python3 tools/extract_animations.py novabeast.glb animations.json --keep-file poses.txt
"""

import argparse
import json
import sys

from glb_common import read_glb, read_accessor_floats, build_node_paths


def extract_animations(gltf, bin_data, keep_names):
    animations = gltf.get("animations", [])
    node_paths = build_node_paths(gltf)

    missing = keep_names - {a["name"] for a in animations}
    if missing:
        print(f"Warning: requested names not found in file: {sorted(missing)}", file=sys.stderr)

    extracted = []
    for anim in animations:
        if anim["name"] not in keep_names:
            continue

        channels_out = []
        for channel in anim["channels"]:
            node_index = channel["target"]["node"]
            node_path = node_paths[node_index]

            sampler = anim["samplers"][channel["sampler"]]
            times, _ = read_accessor_floats(gltf, bin_data, sampler["input"])
            values, component_count = read_accessor_floats(gltf, bin_data, sampler["output"])

            channels_out.append(
                {
                    "targetNodePath": node_path,
                    "path": channel["target"]["path"],
                    "interpolation": sampler.get("interpolation", "LINEAR"),
                    "componentCount": component_count,
                    "times": times,
                    "values": values,
                }
            )

        extracted.append({"name": anim["name"], "channels": channels_out})

    return extracted


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input", help="Source .glb file")
    parser.add_argument("output", help="Destination .json file")
    parser.add_argument("--keep", nargs="*", default=[], help="Animation names to extract")
    parser.add_argument("--keep-file", help="Text file with one animation name per line")
    args = parser.parse_args()

    keep_names = set(args.keep)
    if args.keep_file:
        with open(args.keep_file, "r", encoding="utf-8") as f:
            keep_names |= {line.strip() for line in f if line.strip()}

    if not keep_names:
        parser.error("no animation names given via --keep or --keep-file")

    gltf, bin_data = read_glb(args.input)
    extracted = extract_animations(gltf, bin_data, keep_names)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump({"animations": extracted}, f)

    total_channels = sum(len(a["channels"]) for a in extracted)
    print(f"Extracted {len(extracted)}/{len(keep_names)} requested animations ({total_channels} channels total).")


if __name__ == "__main__":
    main()
