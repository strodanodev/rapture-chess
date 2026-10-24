# Rapture Chess: the main-menu logo, rendered once in Blender as an image (transparent background).
#   blender -b --python scripts/render-logo.py -- public/art/logo.png
# RAPTURE / CHESS in bevelled Cinzel (the game's own font, scripts/fonts), polished gold lit by a studio: a warm key
# from above, a cool rim, and emissive cards that only the reflections see (that is what makes metal read as gold
# rather than brown). Orthographic camera, slightly below the text so the bevels and the extruded depth catch light.
# The page shows the PNG (converted to WebP) over everything, so no scene post-processing or overlay can dim it.
import bpy, math, os, sys

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1:][0])
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def principled(name, color, metallic, rough, emit=None, strength=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


GOLD = principled("gold", (1.0, 0.72, 0.34), 1.0, 0.2)
# a vertical gradient through each word, deep amber at the foot to pale gold at the crown: polished gold lettering
_nt = GOLD.node_tree
_tc = _nt.nodes.new("ShaderNodeTexCoord")
_sep = _nt.nodes.new("ShaderNodeSeparateXYZ")
_ramp = _nt.nodes.new("ShaderNodeValToRGB")
_ramp.color_ramp.elements[0].color = (0.72, 0.36, 0.07, 1)
_ramp.color_ramp.elements[1].color = (1.0, 0.86, 0.48, 1)
_mid = _ramp.color_ramp.elements.new(0.55)
_mid.color = (1.0, 0.68, 0.22, 1)
_nt.links.new(_tc.outputs["Generated"], _sep.inputs[0])
_nt.links.new(_sep.outputs["Y"], _ramp.inputs["Fac"])   # a text object's own Y is up the letters
_nt.links.new(_ramp.outputs["Color"], next(n for n in _nt.nodes if n.type == "BSDF_PRINCIPLED").inputs["Base Color"])


def word(text, font, size, extrude, bevel, spacing, z):
    cu = bpy.data.curves.new(text, "FONT")
    cu.body = text
    cu.font = bpy.data.fonts.load(os.path.join(FONTS, font))
    cu.size = size
    cu.align_x = "CENTER"
    cu.space_character = spacing
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.bevel_resolution = 3
    cu.offset = -bevel * 0.5
    cu.materials.append(GOLD)
    o = bpy.data.objects.new(text, cu)
    scene.collection.objects.link(o)
    o.rotation_euler = (math.radians(90), 0, 0)   # stand up, facing -Y (the camera)
    o.location = (0, 0, z)
    return o


word("RAPTURE", "Cinzel-Black.ttf", 1.42, 0.14, 0.03, 1.02, 0.0)
word("CHESS", "Cinzel-Bold.ttf", 0.6, 0.08, 0.018, 1.95, -0.92)


def light(name, kind, energy, loc, rot, color=(1, 1, 1), size=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = energy
    ld.color = color
    if size is not None:
        ld.size = size
    o = bpy.data.objects.new(name, ld)
    o.location = loc
    o.rotation_euler = [math.radians(a) for a in rot]
    scene.collection.objects.link(o)


light("Key", "AREA", 900, (-3, -6, 6), (55, 0, -25), (1.0, 0.92, 0.8), 6)
light("Fill", "AREA", 250, (5, -6, -1), (100, 0, 35), (1.0, 0.85, 0.65), 5)
light("Rim", "AREA", 700, (0, 4, 4), (-50, 0, 0), (0.75, 0.85, 1.0), 8)


def card(name, loc, rot, w, h, color, strength):
    """A bright panel the camera never sees, only the gold's reflections."""
    bpy.ops.mesh.primitive_plane_add(size=1, location=loc, rotation=[math.radians(a) for a in rot])
    p = bpy.context.active_object
    p.name = name
    p.scale = (w, h, 1)
    p.data.materials.append(principled(name, (0, 0, 0), 0, 1, color, strength))
    p.visible_camera = False
    p.visible_shadow = False


# the letter faces look straight back at the camera, so what sits behind the camera is what the gold shows: a bright
# warm panel over a dimmer one gives the classic polished-gold gradient; the bevels pick up the top and bottom cards
card("FaceHigh", (0, -16, 1.6), (90, 0, 0), 30, 3.2, (1.0, 0.86, 0.6), 3.2)
card("FaceLow", (0, -16, -1.6), (90, 0, 0), 30, 3.2, (0.85, 0.45, 0.12), 0.9)
card("SkyCard", (0, -3, 5), (60, 0, 0), 14, 3, (1.0, 0.95, 0.85), 6)
card("FloorCard", (0, -3, -4), (-60, 0, 0), 14, 2, (0.9, 0.55, 0.2), 2)

w = scene.world or bpy.data.worlds.new("World")
scene.world = w
w.use_nodes = True
bg = next(n for n in w.node_tree.nodes if n.type == "BACKGROUND")
# a studio gradient as the world: the transparent film hides it from the image, but EEVEE's reflections only see the
# world and what is on screen, so this is what the gold mirrors. A bright warm band at the horizon (the letter faces
# look straight back along it), dark brown below, a softer cream above for the top bevels.
nt = w.node_tree
tc = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
rng = nt.nodes.new("ShaderNodeMapRange")
rng.inputs["From Min"].default_value, rng.inputs["From Max"].default_value = -1.0, 1.0
ramp = nt.nodes.new("ShaderNodeValToRGB")
el = ramp.color_ramp.elements
el[0].position, el[0].color = 0.25, (0.04, 0.02, 0.005, 1)
el[1].position, el[1].color = 1.0, (0.55, 0.45, 0.32, 1)
for pos, col in ((0.44, (0.35, 0.18, 0.05, 1)), (0.5, (1.0, 0.82, 0.5, 1)), (0.58, (0.9, 0.7, 0.4, 1)), (0.7, (0.18, 0.1, 0.04, 1))):
    e = el.new(pos)
    e.color = col
nt.links.new(tc.outputs["Generated"], sep.inputs[0])
nt.links.new(sep.outputs["Z"], rng.inputs["Value"])
nt.links.new(rng.outputs["Result"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], bg.inputs[0])
bg.inputs[1].default_value = 1.6

cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
scene.collection.objects.link(cam)
cam.data.type = "ORTHO"
# frame the letters: measure their evaluated bounds, centre the camera on them, fit the width with a margin
from mathutils import Vector
dg = bpy.context.evaluated_depsgraph_get()
pts = [o.matrix_world @ Vector(c) for o in scene.objects if o.type == "FONT" for c in o.evaluated_get(dg).bound_box]
x0, x1 = min(p.x for p in pts), max(p.x for p in pts)
z0, z1 = min(p.z for p in pts), max(p.z for p in pts)
print("TEXT", round(x0, 2), round(x1, 2), round(z0, 2), round(z1, 2))
cz, tilt = (z0 + z1) / 2, math.radians(3)        # a touch below the text, looking up: the extruded depth shows under it
cam.data.ortho_scale = (x1 - x0) * 1.08
cam.location = (0, -12, cz - 12 * math.tan(tilt))
cam.rotation_euler = (math.pi / 2 + tilt, 0, 0)   # x rotation over 90 degrees tips the view up
scene.camera = cam

engines = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
scene.render.engine = next(e for e in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES") if e in engines)
if scene.render.engine == "CYCLES":
    scene.cycles.samples = 96
else:
    try:
        scene.eevee.taa_render_samples = 64
        scene.eevee.use_raytracing = True
    except AttributeError:
        pass
scene.render.film_transparent = True
scene.render.resolution_x = 2400
scene.render.resolution_y = int(2400 * (z1 - z0 + 0.25) / ((x1 - x0) * 1.08))
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
except TypeError:
    scene.view_settings.view_transform = "Filmic"
scene.render.filepath = out
bpy.ops.render.render(write_still=True)
# crop to the letters (plus a margin) so the page can size the image by its real bounds
img = bpy.data.images.load(out)
w, h = img.size
px = img.pixels[:]
rows = [y for y in range(h) if any(px[(y * w + x) * 4 + 3] > 0.02 for x in range(0, w, 3))]
cols = [x for x in range(w) if any(px[(y * w + x) * 4 + 3] > 0.02 for y in range(0, h, 3))]
print("BOUNDS", min(cols), min(rows), max(cols), max(rows), "of", w, h)
print("RENDER", scene.render.engine, out)
