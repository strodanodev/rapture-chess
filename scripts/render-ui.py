# Rapture Chess: the UI's embossed metalwork, modelled and rendered in Blender (transparent PNGs, then WebP).
#   blender -b --python scripts/render-ui.py -- renders/ui
#   python scripts/ui-webp.py renders/ui public/ui
# Every piece is a real bevelled solid seen straight down by an orthographic camera, lit from the upper left, so the
# CSS only stretches pictures of 3D metal (border-image nine-slices) and never fakes the bevels:
#   btn-gold / btn-dark / btn-crimson   the chamfered button plates, a gem set in each tip (slice 0 L 0 R)
#   plate / plate-gold                  the menu tiles, tabs and segments: chamfered corners, rivets (slice on all sides)
#   frame                               the panel frame: a moulded gilt rail, a gem boss on every corner (hollow centre)
#   medallion / medallion-gold          the round icon buttons: gilt ring, studs, enamel or gold face
# The middle of every nine-slice is uniform along the axis it stretches on: rims, grooves and inlays only.
import bpy, bmesh, math, os, sys
from mathutils import Vector

out_dir = os.path.abspath(sys.argv[sys.argv.index("--") + 1:][0])
os.makedirs(out_dir, exist_ok=True)


# ---------------------------------------------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = next(e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES") if e in engines)
    if scene.render.engine == "CYCLES":
        scene.cycles.samples = 64
    else:
        try:
            scene.eevee.taa_render_samples = 48
            scene.eevee.use_raytracing = True
        except AttributeError:
            pass
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Punchy"
    except TypeError:
        scene.view_settings.view_transform = "Filmic"
    # the studio the metal mirrors: a gradient along the light direction (upper left, above). Faces looking straight
    # up mirror the middle of it (warm gold), bevels turned to the light mirror the bright end, bevels turned away the
    # dark end: that is the emboss.
    w = bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    dot.inputs[1].default_value = Vector((-0.5, 0.5, 0.71)).normalized()
    rng = nt.nodes.new("ShaderNodeMapRange")
    rng.inputs["From Min"].default_value, rng.inputs["From Max"].default_value = -1.0, 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = 0.0, (0.004, 0.002, 0.001, 1)
    el[1].position, el[1].color = 1.0, (1.0, 0.97, 0.88, 1)
    for pos, col in ((0.7, (0.012, 0.006, 0.002, 1)), (0.84, (0.3, 0.16, 0.05, 1)), (0.885, (0.95, 0.7, 0.34, 1)), (0.94, (1.0, 0.9, 0.62, 1))):
        e = el.new(pos)
        e.color = col
    nt.links.new(tc.outputs["Generated"], dot.inputs[0])
    nt.links.new(dot.outputs["Value"], rng.inputs["Value"])
    nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs[0])
    bg.inputs[1].default_value = 1.25
    sun("Key", (1, -1, -1.2), 3.2, (1.0, 0.93, 0.82))
    sun("Fill", (-1, 1, -0.8), 0.25, (0.75, 0.82, 1.0))
    return scene


def sun(name, direction, energy, color):
    ld = bpy.data.lights.new(name, "SUN")
    ld.energy = energy
    ld.color = color
    ld.angle = math.radians(12)
    o = bpy.data.objects.new(name, ld)
    o.rotation_euler = Vector(direction).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(o)


def mat(name, color, metal, rough, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def shaded(name, top, bottom, metal, rough, half):
    """A face lit from above: its colour runs from `top` to `bottom` over the object's own height (2 x `half`)."""
    m = mat(name, top, metal, rough)
    nt = m.node_tree
    tc, sep, rng, mix = (nt.nodes.new(t) for t in ("ShaderNodeTexCoord", "ShaderNodeSeparateXYZ", "ShaderNodeMapRange", "ShaderNodeMix"))
    mix.data_type = "RGBA"
    rng.inputs["From Min"].default_value, rng.inputs["From Max"].default_value = -half, half
    mix.inputs[6].default_value = (*bottom, 1)
    mix.inputs[7].default_value = (*top, 1)
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    nt.links.new(sep.outputs["Y"], rng.inputs["Value"])
    nt.links.new(rng.outputs["Result"], mix.inputs[0])
    nt.links.new(mix.outputs[2], next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"])
    return m


HALF = {"h": 0.64}          # half the height of the piece being built (each builder sets it before making faces)
GOLD = lambda: mat("gold", (1.0, 0.7, 0.28), 1.0, 0.17)
SATIN = lambda: shaded("satin", (1.0, 0.86, 0.52), (0.85, 0.5, 0.14), 1.0, 0.26, HALF["h"])
OBSIDIAN = lambda: shaded("obsidian", (0.075, 0.06, 0.11), (0.006, 0.004, 0.01), 0.0, 0.28, HALF["h"])
CRIMSON = lambda: shaded("crimson", (0.5, 0.045, 0.03), (0.1, 0.006, 0.004), 0.05, 0.26, HALF["h"])
GEM = lambda c: mat("gem", c, 0.0, 0.04, c, 0.9)
RUBY, SAPPHIRE, AMBER = (0.6, 0.0, 0.02), (0.02, 0.16, 0.9), (0.9, 0.32, 0.0)


def render(name, w, h, ppu):
    scene = bpy.context.scene
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = max(w, h)
    cam.location = (0, 0, 10)
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = round(w * ppu), round(h * ppu)
    scene.render.filepath = os.path.join(out_dir, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print("RENDER", name, scene.render.resolution_x, scene.render.resolution_y)


# ---------------------------------------------------------------------------------------------------- modelling
def faces_of(geom):
    return [g for g in geom if isinstance(g, bmesh.types.BMFace)]


def prism(poly, depth):
    """A flat polygon extruded up by `depth`; returns the bmesh and its top face. Every face starts as material 0."""
    bm = bmesh.new()
    f = bm.faces.new([bm.verts.new((x, y, 0)) for x, y in poly])
    if f.normal.z < 0:
        f.normal_flip()
    top = faces_of(bmesh.ops.extrude_face_region(bm, geom=[f])["geom"])[0]
    bmesh.ops.translate(bm, verts=top.verts, vec=(0, 0, depth))
    bmesh.ops.delete(bm, geom=[f], context="FACES_ONLY")
    for fc in bm.faces:
        fc.material_index = 0
    return bm, top


def step(bm, face, inset, dz, ring, wall, inner):
    """Inset `face` (the new ring takes material `ring`), then move what is left of it by `dz` (the walls take `wall`)."""
    if inset:
        for fc in bmesh.ops.inset_region(bm, faces=[face], thickness=inset, use_even_offset=True)["faces"]:
            fc.material_index = ring
    if dz:
        before = set(bm.faces)
        bmesh.ops.extrude_face_region(bm, geom=[face])
        new = [f for f in bm.faces if f not in before]
        moved = max(new, key=lambda f: abs(f.normal.z))
        bmesh.ops.translate(bm, verts=moved.verts, vec=(0, 0, dz))
        bmesh.ops.delete(bm, geom=[face], context="FACES_ONLY")
        for f in new:
            f.material_index = wall
        face = moved
    face.material_index = inner
    return face


def solid(name, bm, mats, bevel=0.02):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(m)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    for p in me.polygons:
        p.use_smooth = True
    if hasattr(me, "set_sharp_from_angle"):
        me.set_sharp_from_angle(angle=math.radians(30))
    if bevel:
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = 3
        b.limit_method = "ANGLE"
        b.angle_limit = math.radians(30)
    return o


def gem(name, x, y, z, size, material, height=0.55):
    """A cut stone: an octahedron, flattened, turned 45 degrees (a diamond seen from above)."""
    bm = bmesh.new()
    top, bot = bm.verts.new((0, 0, size * height)), bm.verts.new((0, 0, -size * 0.2))
    ring = [bm.verts.new((size * math.cos(i * math.pi / 2), size * math.sin(i * math.pi / 2), 0)) for i in range(4)]
    for i in range(4):
        bm.faces.new((ring[i], ring[(i + 1) % 4], top))
        bm.faces.new((ring[(i + 1) % 4], ring[i], bot))
    o = solid(name, bm, [material], bevel=0)
    for p in o.data.polygons:
        p.use_smooth = False
    o.location = (x, y, z)
    return o


def stud(name, x, y, z, r, material, squash=0.55):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=(x, y, z), segments=16, ring_count=8)
    o = bpy.context.active_object
    o.name = name
    o.scale.z = squash
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


def circle(r, n=64):
    return [(r * math.cos(i * math.tau / n), r * math.sin(i * math.tau / n)) for i in range(n)]


# ---------------------------------------------------------------------------------------------------- pieces
BW, BH = 4.8, 1.28
BCUT = 0.3 * BH            # matches the CSS clip-path: the tip is 30% of the height in from each end


def button(name, face, gem_color, inlay="gold"):
    reset()
    HALF["h"] = BH / 2
    face_mat = face()
    poly = [(-BW / 2 + BCUT, BH / 2), (BW / 2 - BCUT, BH / 2), (BW / 2, 0), (BW / 2 - BCUT, -BH / 2), (-BW / 2 + BCUT, -BH / 2), (-BW / 2, 0)]
    bm, top = prism(poly, 0.22)
    f = step(bm, top, 0.12, -0.08, 0, 0, 1)     # the gilt rim, then down a bevelled step to the face
    f = step(bm, f, 0.034, 0, 1, 1, 1)          # a margin of face
    f = step(bm, f, 0.02, 0, 2, 2, 1)           # a fine inlaid line round the face
    solid(name, bm, [GOLD(), face_mat, GOLD() if inlay == "gold" else SATIN()], bevel=0.045)
    g = GEM(gem_color)
    for s in (-1, 1):
        stud(f"{name}_set{s}", s * (BW / 2 - 0.22), 0, 0.17, 0.17, GOLD(), squash=0.3)   # the low gold setting
        gem(f"{name}_gem{s}", s * (BW / 2 - 0.22), 0, 0.22, 0.14, g, height=0.6)        # the stone, standing proud of it
    render(name, BW, BH, 180)


PW, PH, PCUT = 3.2, 1.6, 0.14


def plate(name, face):
    reset()
    HALF["h"] = PH / 2
    face_mat = face()
    a, b, c = PW / 2, PH / 2, PCUT
    poly = [(-a + c, b), (a - c, b), (a, b - c), (a, -b + c), (a - c, -b), (-a + c, -b), (-a, -b + c), (-a, b - c)]
    bm, top = prism(poly, 0.16)
    f = step(bm, top, 0.075, -0.06, 0, 0, 1)
    f = step(bm, f, 0.05, 0, 1, 1, 1)
    f = step(bm, f, 0.016, 0, 2, 2, 1)
    solid(name, bm, [GOLD(), face_mat, GOLD()], bevel=0.035)
    g = GOLD()
    for sx in (-1, 1):
        for sy in (-1, 1):
            stud(f"{name}_rivet{sx}{sy}", sx * (a - 0.17), sy * (b - 0.17), 0.115, 0.05, g)
    render(name, PW, PH, 180)


FS = 2.0          # the frame image spans -FS..FS
FO = 1.80         # the outer edge of the rail


def frame(name):
    reset()
    poly = [(-FO, -FO), (FO, -FO), (FO, FO), (-FO, FO)]
    bm, top = prism(poly, 0.16)
    HALF["h"] = FS
    f = step(bm, top, 0.06, -0.05, 0, 0, 1)     # the outer gilt lip, down into a dark groove
    f = step(bm, f, 0.04, 0.09, 1, 0, 0)        # the groove, then up onto the moulded rail
    f = step(bm, f, 0.09, -0.09, 0, 0, 0)       # the crown of the rail, then down its inner side
    bmesh.ops.delete(bm, geom=[f], context="FACES_ONLY")   # a hollow frame: the panel shows through
    solid(name, bm, [GOLD(), mat("groove", (0.01, 0.007, 0.012), 0, 0.5)], bevel=0.03)
    rail = FO - (0.06 + 0.04 + 0.09) / 2
    g = GOLD()
    stone = GEM(RUBY)
    for sx in (-1, 1):
        for sy in (-1, 1):
            # the corner boss: a diamond-shaped gilt plaque, bevelled, a ruby set in it
            bm, t = prism([(0.3, 0), (0, 0.3), (-0.3, 0), (0, -0.3)], 0.24)
            step(bm, t, 0.07, -0.05, 0, 0, 0)
            boss = solid(f"{name}_boss{sx}{sy}", bm, [g], bevel=0.03)
            boss.location = (sx * rail, sy * rail, 0)
            gem(f"{name}_gem{sx}{sy}", sx * rail, sy * rail, 0.21, 0.13, stone, height=0.65)
    render(name, FS * 2, FS * 2, 160)


MR = 1.0


def medallion(name, face):
    reset()
    HALF["h"] = MR
    face_mat = face()
    bm, top = prism(circle(MR), 0.16)
    f = step(bm, top, 0.075, 0, 0, 0, 0)        # the gilt ring
    f = step(bm, f, 0.035, -0.06, 0, 0, 1)      # down a bevelled step to the face
    f = step(bm, f, 0.018, 0, 2, 2, 1)          # a fine inlay ring
    solid(name, bm, [GOLD(), face_mat, GOLD()], bevel=0.04)
    g = GOLD()
    for i in range(8):
        a = i * math.tau / 8 + math.pi / 8
        stud(f"{name}_stud{i}", (MR - 0.04) * math.cos(a), (MR - 0.04) * math.sin(a), 0.165, 0.03, g)
    render(name, MR * 2.08, MR * 2.08, 128)


# materials are passed as factories: reset() empties the file, so each is made after it
button("btn-gold", SATIN, RUBY, inlay="satin")
button("btn-dark", OBSIDIAN, SAPPHIRE)
button("btn-crimson", CRIMSON, AMBER)
plate("plate", OBSIDIAN)
plate("plate-gold", SATIN)
frame("frame")
medallion("medallion", OBSIDIAN)
medallion("medallion-gold", SATIN)
