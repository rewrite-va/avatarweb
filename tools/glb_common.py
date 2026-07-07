"""Shared glb read/write helpers for the animation extract/merge scripts."""

import json
import struct

GLB_MAGIC = 0x46546C67
JSON_CHUNK_TYPE = 0x4E4F534A
BIN_CHUNK_TYPE = 0x004E4942

# glTF accessor componentType constants used by animation samplers.
COMPONENT_TYPE_FLOAT = 5126

TYPE_TO_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def build_node_paths(gltf):
    """Map every node index to a '/'-joined path of names from a scene root
    down to it (e.g. 'Novabeast_lilToon/clothing/shirt'). Bare node names
    are NOT reliably unique in these exports — VRCFury adds a parallel
    "menu" preview hierarchy that reuses names like "shirt"/"clothing"/
    "skeleton" from the real mesh/skeleton tree — so matching by full path
    is what actually disambiguates them."""
    nodes = gltf["nodes"]
    paths = {}

    def visit(node_index, prefix):
        node = nodes[node_index]
        name = node.get("name", f"#{node_index}")
        path = f"{prefix}/{name}" if prefix else name
        paths[node_index] = path
        for child_index in node.get("children", []):
            visit(child_index, path)

    roots = gltf.get("scenes", [{}])[gltf.get("scene", 0)].get("nodes", [])
    for root_index in roots:
        visit(root_index, "")

    # Any node unreachable from a scene root (shouldn't normally happen, but
    # don't silently drop it) falls back to just its bare name.
    for i, node in enumerate(nodes):
        if i not in paths:
            paths[i] = node.get("name", f"#{i}")

    return paths


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()

    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise ValueError(f"{path} is not a glb file (bad magic)")

    offset = 12
    json_chunk = None
    bin_chunk = b""

    while offset < length:
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        chunk_data = data[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == JSON_CHUNK_TYPE:
            json_chunk = json.loads(chunk_data.decode("utf-8"))
        elif chunk_type == BIN_CHUNK_TYPE:
            bin_chunk = chunk_data
        offset += 8 + chunk_len

    if json_chunk is None:
        raise ValueError(f"{path}: no JSON chunk found")

    return json_chunk, bin_chunk


def write_glb(path, gltf, bin_data):
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    # glTF spec: each chunk padded to a 4-byte boundary (space for JSON, zero for BIN).
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b" " * json_pad

    bin_pad = (4 - len(bin_data) % 4) % 4
    bin_data = bin_data + b"\x00" * bin_pad

    total_len = 12 + 8 + len(json_bytes) + (8 + len(bin_data) if bin_data else 0)

    with open(path, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total_len))
        f.write(struct.pack("<II", len(json_bytes), JSON_CHUNK_TYPE))
        f.write(json_bytes)
        if bin_data:
            f.write(struct.pack("<II", len(bin_data), BIN_CHUNK_TYPE))
            f.write(bin_data)


def read_accessor_floats(gltf, bin_data, accessor_index):
    """Decode a FLOAT accessor (no sparse support needed for anim samplers
    in practice) into a flat list of floats, `count * component_count` long."""
    acc = gltf["accessors"][accessor_index]
    if acc["componentType"] != COMPONENT_TYPE_FLOAT:
        raise ValueError(f"accessor {accessor_index}: expected FLOAT, got {acc['componentType']}")

    component_count = TYPE_TO_COUNT[acc["type"]]
    count = acc["count"]

    bv = gltf["bufferViews"][acc["bufferView"]]
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = bv.get("byteStride")
    element_size = component_count * 4

    values = []
    if stride and stride != element_size:
        for i in range(count):
            offset = start + i * stride
            values.extend(struct.unpack_from(f"<{component_count}f", bin_data, offset))
    else:
        values = list(struct.unpack_from(f"<{count * component_count}f", bin_data, start))

    return values, component_count
