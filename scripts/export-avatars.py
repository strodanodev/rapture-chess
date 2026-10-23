# Rapture Chess: re-exports the Rapture champion avatars for the board (Blender CLI, background).
#   blender -b --python scripts/export-avatars.py -- <src dir of slug.glb> <dst dir>
# Keeps the four clips the game plays (idle, attack, hit, death), drops the bounding icosphere and
# Draco-compresses the meshes, which takes a 750 KB meshopt avatar down to about 450 KB.
import bpy, sys, os, glob

src, dst = sys.argv[sys.argv.index("--") + 1:][:2]
os.makedirs(dst, exist_ok=True)
KEEP = {"idle", "attack", "death", "hit"}
for path in sorted(glob.glob(os.path.join(src, "*.glb"))):
    slug = os.path.splitext(os.path.basename(path))[0]
    out = os.path.join(dst, f"{slug}.glb")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    for a in list(bpy.data.actions):
        if a.name not in KEEP:
            bpy.data.actions.remove(a)
    ico = bpy.data.objects.get("Icosphere")
    if ico:
        bpy.data.objects.remove(ico)
    kw = dict(filepath=out, export_format="GLB", export_animations=True, export_apply=True, export_skins=True, export_yup=True, export_image_format="NONE")
    try:
        bpy.ops.export_scene.gltf(**kw, export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                                  export_draco_position_quantization=12, export_draco_normal_quantization=8, export_draco_texcoord_quantization=10)
    except Exception as e:
        print("DRACO FAILED", slug, e)
        bpy.ops.export_scene.gltf(**kw)
    print("AVATAR", slug, os.path.getsize(out))
