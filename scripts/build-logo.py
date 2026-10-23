# Rapture Chess: the main-menu title as bevelled 3D text, built in Blender from the game's own Cinzel and exported
# as public/models/title.glb (the game gives it a gilded material and its sparks; see src/scene/title.ts).
#   blender -b --python scripts/build-logo.py -- public/models
# or in a live Blender (MCP): sys.argv = ["", "--", out_dir]; exec(open(path).read())
# Two meshes: "Rapture" (Cinzel Black, deep bevel) and "Chess" (Cinzel Bold, wide tracking), centred on the origin,
# the word baseline on y = 0 in glTF space, 1 unit = the cap height of RAPTURE.
import bpy, math, os, sys

out_dir = sys.argv[sys.argv.index("--") + 1:][0]
FONTS = os.path.normpath(os.path.join(os.path.abspath(out_dir), "..", "..", "scripts", "fonts"))

if bpy.app.background:
    bpy.ops.wm.read_factory_settings(use_empty=True)
else:
    for coll in (bpy.data.objects, bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.fonts):
        for item in list(coll):
            coll.remove(item)

gold = bpy.data.materials.new("title_gold")
gold.use_nodes = True
bsdf = next(n for n in gold.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (1.0, 0.74, 0.32, 1)
bsdf.inputs["Metallic"].default_value = 1.0
bsdf.inputs["Roughness"].default_value = 0.28


def word(name, text, font, size, extrude, bevel, spacing, y):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = text
    cu.font = bpy.data.fonts.load(os.path.join(FONTS, font), check_existing=True)
    cu.size = size
    cu.align_x = "CENTER"
    cu.align_y = "BOTTOM_BASELINE"
    cu.space_character = spacing
    cu.extrude = extrude
    cu.bevel_depth = bevel
    cu.bevel_resolution = 2
    cu.resolution_u = 5
    cu.offset = -bevel * 0.55          # keep the letters' outline size: the bevel grows inward, not out
    o = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(o)
    o.location = (0, y, 0)
    o.rotation_euler = (math.radians(90), 0, 0)   # stand the text up (Blender Z-up -> faces -Y, the front in glTF)
    cu.materials.append(gold)
    return o


rapture = word("Rapture", "RAPTURE", "Cinzel-Black.ttf", 1.42, 0.16, 0.035, 1.02, 0)
chess = word("Chess", "CHESS", "Cinzel-Bold.ttf", 0.62, 0.09, 0.02, 1.9, 0)
chess.location = (0, 0, -0.95)
rapture.location = (0, 0, 0)

# to meshes, smooth-shaded with sharp letter edges
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = rapture
bpy.ops.object.convert(target="MESH")
for o in (rapture, chess):
    for p in o.data.polygons:
        p.use_smooth = True
    if hasattr(o.data, "set_sharp_from_angle"):
        o.data.set_sharp_from_angle(angle=math.radians(35))

os.makedirs(out_dir, exist_ok=True)
path = os.path.join(out_dir, "title.glb")
kw = dict(filepath=path, export_format="GLB", export_apply=True, export_yup=True, export_animations=False, export_image_format="NONE", use_selection=True)
try:
    bpy.ops.export_scene.gltf(**kw, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6, export_draco_position_quantization=14, export_draco_normal_quantization=10)
except Exception as e:
    print("draco failed", e)
    bpy.ops.export_scene.gltf(**kw)
faces = sum(len(o.data.polygons) for o in (rapture, chess))
dims = [tuple(round(d, 2) for d in o.dimensions) for o in (rapture, chess)]
print("EXPORT title", os.path.getsize(path), "faces", faces, "dims", dims)
