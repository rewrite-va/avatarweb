#!/usr/bin/env python3
"""Merge an animations/ directory (from extract_animations.py) into a glb.

Lets you re-export the avatar's mesh/materials from Unity as often as you
like (a glb with no animations) without having to redo animation work each
time — this stitches every previously-extracted clip in the given directory
back in, matching each channel's target by full scene PATH (not bare name —
VRCFury exports often have duplicate node names via a parallel "menu"
preview hierarchy) against the new file's skeleton.

Usage:
    python3 tools/merge_animations.py novabeast_visuals.glb animations/ novabeast.glb
"""

import argparse
import json
import struct
import sys
from pathlib import Path

from glb_common import read_glb, write_glb, build_node_paths, COMPONENT_TYPE_FLOAT


def build_path_to_node_index(gltf):
    node_paths = build_node_paths(gltf)
    path_to_index = {}
    for node_index, path in node_paths.items():
        path_to_index[path] = node_index
    return path_to_index


def append_bytes_aligned(buf, data):
    """Append data to buf, padding to a 4-byte boundary first. Returns the
    (aligned) byte offset the data was written at."""
    pad = (4 - len(buf) % 4) % 4
    buf.extend(b"\x00" * pad)
    offset = len(buf)
    buf.extend(data)
    return offset


def add_accessor(gltf, buf, values, component_count, gltf_type):
    """Pack a flat float list into a new bufferView+accessor, appended to buf
    (the growing binary blob) and gltf["bufferViews"]/gltf["accessors"]."""
    packed = struct.pack(f"<{len(values)}f", *values)
    byte_offset = append_bytes_aligned(buf, packed)

    bufferview_index = len(gltf["bufferViews"])
    gltf["bufferViews"].append(
        {"buffer": 0, "byteOffset": byte_offset, "byteLength": len(packed)}
    )

    count = len(values) // component_count
    accessor = {
        "bufferView": bufferview_index,
        "componentType": COMPONENT_TYPE_FLOAT,
        "count": count,
        "type": gltf_type,
    }

    if gltf_type == "SCALAR":
        accessor["min"] = [min(values)]
        accessor["max"] = [max(values)]

    accessor_index = len(gltf["accessors"])
    gltf["accessors"].append(accessor)
    return accessor_index


def merge_animations(gltf, bin_data, animations):
    path_to_node_index = build_path_to_node_index(gltf)
    buf = bytearray(bin_data)

    merged_animations = list(gltf.get("animations", []))
    skipped_channel_count = 0

    for anim in animations:
        channels_out = []
        samplers_out = []

        for channel in anim["channels"]:
            node_index = path_to_node_index.get(channel["targetNodePath"])
            if node_index is None:
                skipped_channel_count += 1
                continue

            component_count = channel["componentCount"]
            gltf_type = {1: "SCALAR", 3: "VEC3", 4: "VEC4"}[component_count]

            input_accessor = add_accessor(gltf, buf, channel["times"], 1, "SCALAR")
            output_accessor = add_accessor(gltf, buf, channel["values"], component_count, gltf_type)

            sampler_index = len(samplers_out)
            samplers_out.append(
                {
                    "input": input_accessor,
                    "output": output_accessor,
                    "interpolation": channel["interpolation"],
                }
            )
            channels_out.append(
                {
                    "sampler": sampler_index,
                    "target": {"node": node_index, "path": channel["path"]},
                }
            )

        if channels_out:
            merged_animations.append(
                {"name": anim["name"], "channels": channels_out, "samplers": samplers_out}
            )
        else:
            print(f"Warning: animation '{anim['name']}' had no channels matching this file's nodes; skipped.", file=sys.stderr)

    if skipped_channel_count:
        print(
            f"Warning: {skipped_channel_count} channel(s) skipped — target node path "
            f"not found in this glb's skeleton.",
            file=sys.stderr,
        )

    gltf["animations"] = merged_animations
    gltf["buffers"] = [{"byteLength": len(buf)}]
    return gltf, bytes(buf)


def load_animations_dir(dir_path):
    animations = []
    for file_path in sorted(Path(dir_path).glob("*.json")):
        with open(file_path, "r", encoding="utf-8") as f:
            animations.append(json.load(f))
    return animations


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("visuals_glb", help="Visuals-only .glb (mesh/materials, no animations needed)")
    parser.add_argument("animations_dir", help="Directory of <name>.json files produced by extract_animations.py")
    parser.add_argument("output", help="Destination .glb file")
    args = parser.parse_args()

    gltf, bin_data = read_glb(args.visuals_glb)
    animations = load_animations_dir(args.animations_dir)

    if not animations:
        print(f"Warning: no *.json files found in {args.animations_dir}", file=sys.stderr)

    before_count = len(gltf.get("animations", []))
    gltf, new_bin = merge_animations(gltf, bin_data, animations)

    write_glb(args.output, gltf, new_bin)

    added = len(gltf["animations"]) - before_count
    print(f"Merged {added} animation(s). Total animations in output: {len(gltf['animations'])}.")


if __name__ == "__main__":
    main()
