"""Shared glb read/write helpers for the animation extract/merge scripts."""

import json
import struct
import sys

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


def _find_accessor_indices_in_meshes(gltf):
    """Every accessor a mesh primitive references: attributes, indices, and
    morph target attributes. These must never be removed by animation
    filtering/merging — they aren't animation data at all."""
    used = set()
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            for acc_idx in prim.get("attributes", {}).values():
                used.add(acc_idx)
            if "indices" in prim:
                used.add(prim["indices"])
            for target in prim.get("targets", []):
                for acc_idx in target.values():
                    used.add(acc_idx)
    return used


def _find_accessor_indices_in_skins(gltf):
    used = set()
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    return used


def filter_animations(gltf, bin_data, keep_names):
    """Rewrite gltf/bin_data keeping only animations whose name is in
    keep_names (pass an empty set to strip every animation), dropping every
    accessor/bufferView/byte range that only the removed animations
    referenced. Everything else (meshes, materials, skins, images, the
    skeleton) is left completely untouched. Used by both
    filter_animations.py directly and merge_animations.py, which uses it
    with an empty keep_names to clear out an already-merged file's old
    animation data before appending a fresh set."""
    animations = gltf.get("animations", [])
    kept_animations = [a for a in animations if a["name"] in keep_names]

    missing = keep_names - {a["name"] for a in animations}
    if missing:
        print(f"Warning: requested names not found in file: {sorted(missing)}", file=sys.stderr)

    # The only accessors eligible for removal are ones used EXCLUSIVELY by
    # animations we're dropping. Everything meshes/skins reference must
    # survive regardless of which animations get kept, and anything a KEPT
    # animation references must survive too — so compute "still referenced"
    # directly and completely, rather than trying to special-case what's
    # "only" used by dropped animations (that approach missed mesh/skin
    # references entirely and corrupted the file on first attempt).
    accessors = gltf["accessors"]
    still_referenced_accessors = set()
    still_referenced_accessors |= _find_accessor_indices_in_meshes(gltf)
    still_referenced_accessors |= _find_accessor_indices_in_skins(gltf)
    for anim in kept_animations:
        for sampler in anim["samplers"]:
            still_referenced_accessors.add(sampler["input"])
            still_referenced_accessors.add(sampler["output"])

    keep_accessor_indices = sorted(still_referenced_accessors)
    accessor_old_to_new = {old: new for new, old in enumerate(keep_accessor_indices)}

    # Same logic one level down for bufferViews: collect every bufferView
    # still referenced by something we're keeping — surviving accessors
    # (including their sparse index/value bufferViews) AND images, which
    # reference bufferViews directly rather than through an accessor.
    used_buffer_view_indices = set()

    def note_bufferview(idx):
        if idx is not None:
            used_buffer_view_indices.add(idx)

    for i in keep_accessor_indices:
        acc = accessors[i]
        note_bufferview(acc.get("bufferView"))
        sparse = acc.get("sparse")
        if sparse:
            note_bufferview(sparse["indices"]["bufferView"])
            note_bufferview(sparse["values"]["bufferView"])

    for image in gltf.get("images", []):
        note_bufferview(image.get("bufferView"))

    old_buffer_views = gltf["bufferViews"]
    keep_bufferview_indices = sorted(used_buffer_view_indices)
    bufferview_old_to_new = {old: new for new, old in enumerate(keep_bufferview_indices)}

    # Rebuild the binary buffer containing only the bytes for surviving
    # bufferViews, back-to-back, respecting each one's original byteStride/
    # alignment by just concatenating (glTF doesn't require any particular
    # inter-bufferView padding beyond the buffer being byte-addressable).
    new_bin = bytearray()
    new_buffer_views = []
    for old_idx in keep_bufferview_indices:
        bv = old_buffer_views[old_idx]
        start = bv.get("byteOffset", 0)
        length = bv["byteLength"]
        chunk = bin_data[start : start + length]

        new_bv = dict(bv)
        new_bv["byteOffset"] = len(new_bin)
        new_buffer_views.append(new_bv)
        new_bin.extend(chunk)
        # Keep 4-byte alignment between bufferViews for safety.
        pad = (4 - len(new_bin) % 4) % 4
        new_bin.extend(b"\x00" * pad)

    # Rewrite accessors with remapped bufferView indices.
    new_accessors = []
    for i in keep_accessor_indices:
        acc = dict(accessors[i])
        if "bufferView" in acc:
            acc["bufferView"] = bufferview_old_to_new[acc["bufferView"]]
        if "sparse" in acc:
            acc["sparse"] = json.loads(json.dumps(acc["sparse"]))  # deep copy
            acc["sparse"]["indices"]["bufferView"] = bufferview_old_to_new[
                acc["sparse"]["indices"]["bufferView"]
            ]
            acc["sparse"]["values"]["bufferView"] = bufferview_old_to_new[
                acc["sparse"]["values"]["bufferView"]
            ]
        new_accessors.append(acc)

    # Rewrite kept animations' sampler accessor references to new indices.
    new_animations = []
    for anim in kept_animations:
        new_anim = dict(anim)
        new_anim["samplers"] = [
            {**s, "input": accessor_old_to_new[s["input"]], "output": accessor_old_to_new[s["output"]]}
            for s in anim["samplers"]
        ]
        new_animations.append(new_anim)

    # Every other place that pointed at an accessor/bufferView by index also
    # needs remapping now that those arrays were compacted — meshes, skins,
    # and images all reference them directly and are otherwise untouched by
    # this filter, but their *indices* into accessors/bufferViews shift.
    new_meshes = json.loads(json.dumps(gltf.get("meshes", [])))  # deep copy
    for mesh in new_meshes:
        for prim in mesh.get("primitives", []):
            prim["attributes"] = {
                name: accessor_old_to_new[idx] for name, idx in prim["attributes"].items()
            }
            if "indices" in prim:
                prim["indices"] = accessor_old_to_new[prim["indices"]]
            for target in prim.get("targets", []):
                for name in list(target.keys()):
                    target[name] = accessor_old_to_new[target[name]]

    new_skins = json.loads(json.dumps(gltf.get("skins", [])))  # deep copy
    for skin in new_skins:
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = accessor_old_to_new[skin["inverseBindMatrices"]]

    new_images = json.loads(json.dumps(gltf.get("images", [])))  # deep copy
    for image in new_images:
        if "bufferView" in image:
            image["bufferView"] = bufferview_old_to_new[image["bufferView"]]

    gltf["animations"] = new_animations
    gltf["accessors"] = new_accessors
    gltf["bufferViews"] = new_buffer_views
    gltf["buffers"] = [{"byteLength": len(new_bin)}]
    if "meshes" in gltf:
        gltf["meshes"] = new_meshes
    if "skins" in gltf:
        gltf["skins"] = new_skins
    if "images" in gltf:
        gltf["images"] = new_images

    return gltf, bytes(new_bin)


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
