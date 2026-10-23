# Rapture Chess: builds the board and the six piece plinths in Blender (CLI, background) and exports set.glb.
#   blender -b --python scripts/build-set.py -- public/models/set.glb renders/set.png
# Every object is parametric (spin profiles + bevel), so re-running regenerates the whole set.
import bpy, bmesh, math, sys, os

out_glb, out_png = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
col = bpy.context.collection


def mat(name, base, metallic=0.0, rough=0.5, emis=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    n = next(x for x in m.node_tree.nodes if x.type == "BSDF_PRINCIPLED")
    n.inputs["Base Color"].default_value = (*base, 1.0)
    n.inputs["Metallic"].default_value = metallic
    n.inputs["Roughness"].default_value = rough
    if emis:
        n.inputs["Emission Color"].default_value = (*emis, 1.0)
        n.inputs["Emission Strength"].default_value = strength
    return m


M_LIGHT = mat("board_light", (0.86, 0.82, 0.74), 0.0, 0.25)
M_DARK = mat("board_dark", (0.07, 0.07, 0.09), 0.1, 0.2)
M_FRAME = mat("board_frame", (0.05, 0.045, 0.05), 0.85, 0.35)
M_GOLD = mat("rapture_gold", (1.0, 0.72, 0.28), 1.0, 0.28)
M_PLINTH = mat("plinth_stone", (0.1, 0.1, 0.12), 0.6, 0.38)
M_RUNE = mat("plinth_rune", (0.02, 0.02, 0.02), 0.0, 0.5, (1.0, 0.8, 0.4), 4.0)


def finish(name, o, material, bevel=0.0, smooth=True, parent=None):
    o.name = name
    o.data.name = name
    o.data.materials.append(material)
    if bevel > 0:
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 3
        b.limit_method = "ANGLE"
        b.angle_limit = math.radians(40)
    if smooth:
        for p in o.data.polygons:
            p.use_smooth = True
        if hasattr(o.data, "set_sharp_from_angle"):
            o.data.set_sharp_from_angle(angle=math.radians(40))
    if parent:
        o.parent = parent
    return o


def box(name, size, loc, material, bevel=0.0, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(name, o, material, bevel, smooth=bevel > 0, parent=parent)


def spin(name, profile, material, segments=64, bevel=0.0, parent=None, loc=(0, 0, 0)):
    """profile: list of (radius, z) from the bottom centre up and back to the top centre; revolved about Z."""
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=math.tau, steps=segments, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    o.location = loc
    return finish(name, o, material, bevel, parent=parent)


def ring_box(name, outer, inner, z, depth, material, bevel, parent):
    """A square ring (frame) between half-widths inner and outer, top at z, extruded down by depth."""
    pts = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    bm = bmesh.new()
    vo = [bm.verts.new((x * outer, y * outer, z)) for x, y in pts]
    vi = [bm.verts.new((x * inner, y * inner, z)) for x, y in pts]
    for i in range(4):
        bm.faces.new((vo[i], vo[(i + 1) % 4], vi[(i + 1) % 4], vi[i]))
    r = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    bmesh.ops.translate(bm, verts=[v for v in r["geom"] if isinstance(v, bmesh.types.BMVert)], vec=(0, 0, -depth))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    col.objects.link(o)
    return finish(name, o, material, bevel, parent=parent)


# ------------------------------------------------------------------ board: 8x8 bevelled slabs on a dark frame
SQ = 1.0  # one square = 1 unit; the game places pieces on integer coordinates
root = bpy.data.objects.new("ChessSet", None)
col.objects.link(root)
board = bpy.data.objects.new("Board", None)
col.objects.link(board)
board.parent = root
lights, darks = [], []
for r in range(8):
    for f in range(8):
        light = (f + r) % 2 == 1
        o = box(f"sq_{f}{r}", (SQ * 0.985, SQ * 0.985, 0.08), ((f - 3.5) * SQ, (r - 3.5) * SQ, -0.04), M_LIGHT if light else M_DARK, bevel=0.012)
        (lights if light else darks).append(o)


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    o.data.name = name
    o.parent = board
    return o


join(lights, "Board_Light")
join(darks, "Board_Dark")
ring_box("Frame", 4.7, 4.0, 0.0, 0.16, M_FRAME, 0.05, board)
ring_box("Inlay", 4.08, 4.02, 0.004, 0.03, M_GOLD, 0.002, board)
for i, (x, y) in enumerate([(-1, -1), (1, -1), (1, 1), (-1, 1)]):
    spin(f"Finial_{i}", [(0, 0), (0.22, 0), (0.22, 0.05), (0.16, 0.07), (0.16, 0.16), (0.12, 0.2), (0.07, 0.42), (0.03, 0.6), (0, 0.62)],
         M_GOLD, bevel=0.004, parent=board, loc=(x * 4.45, y * 4.45, 0))

# ------------------------------------------------------------------ plinths: one per piece type, revolved profiles
# (radius, z) from the centre of the bottom, out and up to the centre of the top. The champion avatar stands on the
# top face; the three.js side adds an element-coloured ring in the groove at the base.
PLINTHS = {
    "P": [(0, 0), (0.30, 0), (0.30, 0.03), (0.26, 0.035), (0.26, 0.08), (0.22, 0.10), (0, 0.10)],
    "N": [(0, 0), (0.34, 0), (0.34, 0.03), (0.29, 0.035), (0.29, 0.10), (0.25, 0.115), (0.25, 0.16), (0.21, 0.175), (0, 0.175)],
    "B": [(0, 0), (0.34, 0), (0.34, 0.03), (0.29, 0.035), (0.29, 0.09), (0.24, 0.11), (0.24, 0.17), (0.27, 0.19), (0.27, 0.205), (0.22, 0.21), (0, 0.21)],
    "R": [(0, 0), (0.36, 0), (0.36, 0.03), (0.31, 0.035), (0.31, 0.14), (0.34, 0.15), (0.34, 0.22), (0.26, 0.22), (0.26, 0.19), (0.24, 0.19), (0, 0.19)],
    "Q": [(0, 0), (0.38, 0), (0.38, 0.03), (0.33, 0.035), (0.33, 0.09), (0.28, 0.11), (0.28, 0.20), (0.31, 0.225), (0.31, 0.26), (0.26, 0.275), (0, 0.275)],
    "K": [(0, 0), (0.40, 0), (0.40, 0.03), (0.35, 0.035), (0.35, 0.10), (0.30, 0.125), (0.30, 0.22), (0.34, 0.25), (0.34, 0.30), (0.28, 0.32), (0, 0.32)],
}
plinths = bpy.data.objects.new("Plinths", None)
col.objects.link(plinths)
plinths.parent = root
for i, (k, prof) in enumerate(PLINTHS.items()):
    p = spin(f"Plinth_{k}", prof, M_PLINTH, segments=72, bevel=0.006, parent=plinths, loc=(-5.5 + i * 0.9, 5.6, 0))
    top_r, top_z = prof[-2]
    spin(f"Cap_{k}", [(top_r - 0.03, top_z - 0.002), (top_r + 0.012, top_z - 0.002), (top_r + 0.012, top_z + 0.012), (top_r - 0.03, top_z + 0.012)],
         M_GOLD, segments=72, bevel=0.002, parent=p)
    base_r = prof[1][0]
    spin(f"Rune_{k}", [(base_r - 0.045, 0.036), (base_r + 0.004, 0.036), (base_r + 0.004, 0.05), (base_r - 0.045, 0.05)], M_RUNE, segments=72, parent=p)

# ------------------------------------------------------------------ export
bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(os.path.abspath(out_glb)), exist_ok=True)
kw = dict(filepath=out_glb, export_format="GLB", export_apply=True, export_yup=True, export_animations=False, export_image_format="NONE", use_selection=True)
try:
    bpy.ops.export_scene.gltf(**kw, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                              export_draco_position_quantization=14, export_draco_normal_quantization=10)
    print("EXPORT draco", os.path.getsize(out_glb))
except Exception as e:
    print("EXPORT plain (draco failed:", e, ")")
    bpy.ops.export_scene.gltf(**kw)
    print("EXPORT", os.path.getsize(out_glb))

# ------------------------------------------------------------------ a check render so the set can be eyeballed
cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
col.objects.link(cam)
cam.location = (0, -11.5, 8.5)
cam.rotation_euler = (math.radians(52), 0, 0)
cam.data.lens = 40
scene.camera = cam
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
col.objects.link(sun)
sun.data.energy = 4
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-30))
key = bpy.data.objects.new("Key", bpy.data.lights.new("Key", "AREA"))
col.objects.link(key)
key.location = (4, -4, 7)
key.data.energy = 1800
key.data.size = 4
w = scene.world or bpy.data.worlds.new("World")
scene.world = w
w.use_nodes = True
bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND")
bg.inputs[0].default_value = (0.02, 0.02, 0.03, 1)
bg.inputs[1].default_value = 1.0
engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = next(e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH") if e in engines)
scene.render.resolution_x, scene.render.resolution_y = 1280, 800
scene.render.filepath = os.path.abspath(out_png)
bpy.ops.render.render(write_still=True)
print("RENDER", out_png)
