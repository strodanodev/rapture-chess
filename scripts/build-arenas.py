# Rapture Chess: the two arenas the board stands in, built parametrically in Blender (CLI) and exported as GLBs.
#   blender -b --python scripts/build-arenas.py -- public/models renders
# Valhalla: a ring of carved stone pillars and arches under a great hall roofline, braziers at the corners.
# Underworld: a basalt crater, obsidian spires, a lava moat with bridges, bone-white runestones.
# Both are low-poly on purpose (the pieces are the detail), with emissive materials for the lights the game picks up.
import bpy, bmesh, math, sys, os, random

out_dir, render_dir = sys.argv[sys.argv.index("--") + 1:][:2]


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mat(name, base, metallic=0.0, rough=0.6, emis=None, strength=0.0):
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


def link(o, parent=None):
    bpy.context.collection.objects.link(o)
    if parent:
        o.parent = parent
    return o


def smooth(o, angle=40):
    for p in o.data.polygons:
        p.use_smooth = True
    if hasattr(o.data, "set_sharp_from_angle"):
        o.data.set_sharp_from_angle(angle=math.radians(angle))


def bevel(o, width, segments=2):
    b = o.modifiers.new("bevel", "BEVEL")
    b.width = width
    b.segments = segments
    b.limit_method = "ANGLE"
    b.angle_limit = math.radians(40)


def spin(name, profile, material, segments=24, loc=(0, 0, 0), rot=0, parent=None, bev=0.0):
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    bmesh.ops.spin(bm, geom=verts + edges, cent=(0, 0, 0), axis=(0, 0, 1), angle=math.tau, steps=segments, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me), parent)
    o.location = loc
    o.rotation_euler = (0, 0, rot)
    smooth(o)
    if bev:
        bevel(o, bev)
    return o


def box(name, size, loc, material, rot=(0, 0, 0), parent=None, bev=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    o.name = name
    o.data.name = name
    o.data.materials.append(material)
    if parent:
        o.parent = parent
    if bev:
        bevel(o, bev)
        smooth(o)
    return o


def ring_floor(name, outer, inner, z, depth, material, parent, bev=0.0, sides=4, rot=0.0):
    bm = bmesh.new()
    vo = [bm.verts.new((outer * math.cos(rot + i * math.tau / sides), outer * math.sin(rot + i * math.tau / sides), z)) for i in range(sides)]
    vi = [bm.verts.new((inner * math.cos(rot + i * math.tau / sides), inner * math.sin(rot + i * math.tau / sides), z)) for i in range(sides)]
    for i in range(sides):
        bm.faces.new((vo[i], vo[(i + 1) % sides], vi[(i + 1) % sides], vi[i]))
    r = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    bmesh.ops.translate(bm, verts=[v for v in r["geom"] if isinstance(v, bmesh.types.BMVert)], vec=(0, 0, -depth))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    o = link(bpy.data.objects.new(name, me), parent)
    if bev:
        bevel(o, bev)
        smooth(o)
    return o


def export(name):
    bpy.ops.object.select_all(action="SELECT")
    path = os.path.join(out_dir, f"{name}.glb")
    kw = dict(filepath=path, export_format="GLB", export_apply=True, export_yup=True, export_animations=False, export_image_format="NONE", use_selection=True)
    try:
        bpy.ops.export_scene.gltf(**kw, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                                  export_draco_position_quantization=14, export_draco_normal_quantization=10)
    except Exception as e:
        print("draco failed", e)
        bpy.ops.export_scene.gltf(**kw)
    tris = sum(len(o.data.polygons) for o in bpy.data.objects if o.type == "MESH")
    print("EXPORT", name, os.path.getsize(path), "faces", tris)


def render(name, cam_loc, cam_rot, bg):
    scene = bpy.context.scene
    cam = link(bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam")))
    cam.location = cam_loc
    cam.rotation_euler = cam_rot
    cam.data.lens = 28
    scene.camera = cam
    sun = link(bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN")))
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(55), math.radians(10), math.radians(-30))
    w = scene.world or bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    n = next(x for x in w.node_tree.nodes if x.type == "BACKGROUND")
    n.inputs[0].default_value = (*bg, 1)
    engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = next(e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "BLENDER_WORKBENCH") if e in engines)
    scene.render.resolution_x, scene.render.resolution_y = 1280, 720
    scene.render.filepath = os.path.abspath(os.path.join(render_dir, f"{name}.png"))
    bpy.ops.render.render(write_still=True)
    print("RENDER", name)


# ============================================================================ VALHALLA
def valhalla():
    reset()
    random.seed(7)
    STONE = mat("vh_stone", (0.62, 0.58, 0.52), 0.0, 0.78)
    DARK = mat("vh_dark", (0.16, 0.14, 0.13), 0.1, 0.7)
    GOLD = mat("rapture_gold", (1.0, 0.72, 0.28), 1.0, 0.3)
    FIRE = mat("vh_fire", (0.1, 0.05, 0.02), 0.0, 0.8, (1.0, 0.55, 0.15), 6.0)
    RUNE = mat("vh_rune", (0.05, 0.05, 0.08), 0.0, 0.6, (0.55, 0.8, 1.0), 3.0)
    root = link(bpy.data.objects.new("Valhalla", None))

    # the hall floor: a wide stone octagon around the board, a sunken ring and a raised walkway
    ring_floor("Floor", 17.0, 4.9, -0.17, 0.5, STONE, root, bev=0.03, sides=8, rot=math.pi / 8)
    ring_floor("FloorRing", 5.3, 4.75, -0.12, 0.1, GOLD, root, sides=8, rot=math.pi / 8)
    ring_floor("Walk", 18.5, 16.6, 0.25, 0.6, DARK, root, bev=0.03, sides=8, rot=math.pi / 8)

    # pillars on the octagon, carved (a fluted profile) with gold caps and rune bands
    n = 16
    for i in range(n):
        a = i * math.tau / n + math.pi / 16
        x, y = 15.2 * math.cos(a), 15.2 * math.sin(a)
        prof = [(0, 0), (0.75, 0), (0.75, 0.25), (0.55, 0.3), (0.55, 6.6), (0.7, 6.8), (0.7, 7.1), (0.85, 7.2), (0.85, 7.5), (0, 7.5)]
        p = spin(f"Pillar_{i}", prof, STONE, segments=12, loc=(x, y, 0.2), rot=a, parent=root, bev=0.02)
        spin(f"PillarCap_{i}", [(0.5, 6.55), (0.72, 6.55), (0.72, 6.65), (0.5, 6.65)], GOLD, segments=12, loc=(x, y, 0.2), parent=root)
        spin(f"PillarRune_{i}", [(0.56, 3.0), (0.58, 3.0), (0.58, 3.25), (0.56, 3.25)], RUNE, segments=12, loc=(x, y, 0.2), parent=root)
    # arches between pillars: a lintel ring high up, and a second ring of shorter pillars further out
    ring_floor("Lintel", 16.0, 14.4, 7.9, 0.5, STONE, root, bev=0.03, sides=16, rot=math.pi / 16)
    ring_floor("LintelGold", 15.3, 15.1, 7.95, 0.08, GOLD, root, sides=16, rot=math.pi / 16)
    for i in range(8):
        a = i * math.tau / 8
        x, y = 24.0 * math.cos(a), 24.0 * math.sin(a)
        spin(f"Outer_{i}", [(0, 0), (1.2, 0), (1.2, 0.3), (0.9, 0.4), (0.9, 11.0), (1.1, 11.3), (1.1, 11.8), (0, 11.8)], STONE, segments=10, loc=(x, y, -0.5), parent=root, bev=0.03)
    # braziers at the four board corners: a bowl on a tripod with an emissive fire core
    for (sx, sy) in [(-1, -1), (1, -1), (1, 1), (-1, 1)]:
        x, y = sx * 6.6, sy * 6.6
        spin("Brazier", [(0, 0), (0.45, 0), (0.45, 0.08), (0.12, 0.12), (0.12, 1.1), (0.55, 1.25), (0.62, 1.55), (0.5, 1.6), (0.45, 1.35), (0, 1.3)], DARK, segments=16, loc=(x, y, 0), parent=root, bev=0.01)
        spin("BrazierFire", [(0, 1.3), (0.4, 1.32), (0.3, 1.7), (0.12, 2.0), (0, 2.05)], FIRE, segments=10, loc=(x, y, 0), parent=root)
    # great hall roof beams: radial dark beams that read as a vaulted ceiling against the sky
    for i in range(16):
        a = i * math.tau / 16 + math.pi / 16
        box(f"Beam_{i}", (12.0, 0.35, 0.45), (13.0 * math.cos(a), 13.0 * math.sin(a), 15.0), DARK, rot=(0, math.radians(-18), a), parent=root, bev=0.02)
    # a few fallen stone blocks and standing runestones around the floor for scale
    for i in range(10):
        a = random.uniform(0, math.tau)
        r = random.uniform(10.5, 13.5)
        box(f"Block_{i}", (random.uniform(0.6, 1.4), random.uniform(0.6, 1.0), random.uniform(0.4, 0.9)), (r * math.cos(a), r * math.sin(a), 0.5), STONE, rot=(0, 0, a), parent=root, bev=0.04)
    for i in range(6):
        a = i * math.tau / 6 + 0.3
        box(f"Runestone_{i}", (0.9, 0.3, 2.6), (12.5 * math.cos(a), 12.5 * math.sin(a), 1.5), STONE, rot=(0, 0, a), parent=root, bev=0.05)
        box(f"RunestoneGlyph_{i}", (0.5, 0.05, 1.6), (12.35 * math.cos(a) + 0.16 * math.sin(a), 12.35 * math.sin(a) - 0.16 * math.cos(a), 1.6), RUNE, rot=(0, 0, a), parent=root)
    export("valhalla")
    render("valhalla", (3, -17, 15), (math.radians(50), 0, math.radians(10)), (0.06, 0.07, 0.1))


# ============================================================================ UNDERWORLD
def underworld():
    reset()
    random.seed(13)
    BASALT = mat("uw_basalt", (0.07, 0.06, 0.07), 0.15, 0.85)
    OBSIDIAN = mat("uw_obsidian", (0.03, 0.02, 0.04), 0.4, 0.25)
    LAVA = mat("uw_lava", (0.2, 0.05, 0.0), 0.0, 0.9, (1.0, 0.3, 0.05), 5.0)
    BONE = mat("uw_bone", (0.78, 0.72, 0.6), 0.0, 0.7)
    EMBER = mat("uw_ember", (0.05, 0.02, 0.01), 0.0, 0.9, (1.0, 0.45, 0.1), 4.0)
    root = link(bpy.data.objects.new("Underworld", None))

    # crater floor: basalt plates around the board, a lava moat, then a wider broken basalt field
    ring_floor("Plate", 6.4, 4.9, -0.17, 0.6, BASALT, root, bev=0.04, sides=8, rot=math.pi / 8)
    ring_floor("Lava", 9.0, 6.3, -0.45, 0.2, LAVA, root, sides=24)
    ring_floor("Field", 22.0, 8.8, -0.3, 0.7, BASALT, root, bev=0.05, sides=12, rot=math.pi / 12)
    # four bridges over the moat, bone-edged
    for i in range(4):
        a = i * math.tau / 4 + math.pi / 4
        box(f"Bridge_{i}", (3.4, 1.4, 0.3), (7.6 * math.cos(a), 7.6 * math.sin(a), -0.25), OBSIDIAN, rot=(0, 0, a), parent=root, bev=0.03)
        for s in (-1, 1):
            box(f"BridgeRail_{i}{s}", (3.4, 0.1, 0.25), (7.6 * math.cos(a) - s * 0.7 * math.sin(a), 7.6 * math.sin(a) + s * 0.7 * math.cos(a), -0.02), BONE, rot=(0, 0, a), parent=root)
    # obsidian spires: tall jagged cones in a ring, leaning outward, with ember cracks (thin emissive bands)
    for i in range(14):
        a = i * math.tau / 14 + random.uniform(-0.12, 0.12)
        r = random.uniform(16.0, 20.0)
        h = random.uniform(7.0, 15.0)
        x, y = r * math.cos(a), r * math.sin(a)
        prof = [(0, 0), (1.6, 0), (1.3, h * 0.25), (0.9, h * 0.5), (0.5, h * 0.78), (0.12, h), (0, h)]
        o = spin(f"Spire_{i}", prof, OBSIDIAN, segments=7, loc=(x, y, -0.6), rot=a, parent=root)
        o.rotation_euler = (math.radians(random.uniform(-8, 8)), math.radians(random.uniform(4, 14)), a)
        spin(f"SpireEmber_{i}", [(0.95, h * 0.45), (1.0, h * 0.45), (1.0, h * 0.48), (0.95, h * 0.48)], EMBER, segments=7, loc=(x, y, -0.6), rot=a, parent=root)
    # lava falls: tall emissive slabs on two far spires
    for i, a in enumerate((0.9, 3.9)):
        box(f"LavaFall_{i}", (0.6, 0.12, 9.0), (20.5 * math.cos(a), 20.5 * math.sin(a), 4.0), LAVA, rot=(0, 0, a), parent=root)
    # bone totems and skull-like boulders near the board
    for i in range(8):
        a = i * math.tau / 8 + 0.2
        spin(f"Totem_{i}", [(0, 0), (0.3, 0), (0.22, 0.4), (0.3, 1.2), (0.18, 2.2), (0.3, 2.6), (0.2, 3.1), (0, 3.2)], BONE, segments=8, loc=(11.5 * math.cos(a), 11.5 * math.sin(a), 0.1), parent=root, bev=0.02)
    for i in range(12):
        a = random.uniform(0, math.tau)
        r = random.uniform(10.5, 15.0)
        s = random.uniform(0.5, 1.2)
        spin(f"Boulder_{i}", [(0, 0), (s, 0), (s * 0.9, s * 0.6), (s * 0.5, s * 1.1), (0, s * 1.2)], BASALT, segments=7, loc=(r * math.cos(a), r * math.sin(a), 0.1), rot=a, parent=root)
    # a cracked dome of ribs overhead (reads as the cavern roof)
    for i in range(12):
        a = i * math.tau / 12
        box(f"Rib_{i}", (14.0, 0.5, 0.8), (11.0 * math.cos(a), 11.0 * math.sin(a), 13.5), BASALT, rot=(0, math.radians(-22), a), parent=root, bev=0.03)
    export("underworld")
    render("underworld", (3, -17, 15), (math.radians(50), 0, math.radians(10)), (0.04, 0.01, 0.01))


os.makedirs(out_dir, exist_ok=True)
os.makedirs(render_dir, exist_ok=True)
valhalla()
underworld()
