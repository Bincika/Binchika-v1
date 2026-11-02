# Renders the About/contact background: Nigeria's 37 states extruded in bronze (height = House seats).
# Usage: blender -b -P scripts/blender/render_contact_bg.py -- <project_root> <out.png> [samples]
import bpy, bmesh, json, math, sys, os

argv = sys.argv[sys.argv.index("--") + 1:]
ROOT, OUT = argv[0], argv[1]
SAMPLES = int(argv[2]) if len(argv) > 2 else 64

topo = json.load(open(os.path.join(ROOT, "site/data/geo/ng-states.topo.json"), encoding="utf-8"))
meta = json.load(open(os.path.join(ROOT, "site/data/states.json"), encoding="utf-8"))
house = {s["iso"]: s["house"] for s in meta["states"]}
zone = {s["iso"]: s["zone"] for s in meta["states"]}

# --- TopoJSON decode (quantized, delta-encoded arcs) ---
sx, sy = topo["transform"]["scale"]; tx, ty = topo["transform"]["translate"]
arcs = []
for arc in topo["arcs"]:
    x = y = 0; pts = []
    for dx, dy in arc:
        x += dx; y += dy
        pts.append((x * sx + tx, y * sy + ty))
    arcs.append(pts)
def ring(idx):
    out = []
    for i in idx:
        pts = arcs[i] if i >= 0 else list(reversed(arcs[~i]))
        out.extend(pts if not out else pts[1:])
    return out
lat0 = math.radians(9.0)
def proj(p):  # simple equirectangular around Nigeria, ~1 unit per degree
    return ((p[0] - 8.7) * math.cos(lat0), p[1] - 9.1)

# --- scene reset ---
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 2400, 1350
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Punchy"

def mat(name, rgb, metal, rough):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Metallic"].default_value = metal; b.inputs["Roughness"].default_value = rough
    return m
TINT = {"NW": (0.80, 0.42, 0.12), "NE": (0.70, 0.36, 0.11), "NC": (0.86, 0.50, 0.18), "SW": (0.74, 0.33, 0.10), "SE": (0.66, 0.30, 0.09), "SS": (0.78, 0.40, 0.14)}
mats = {z: mat("bronze_" + z, c, 1.0, 0.28) for z, c in TINT.items()}

geoms = list(topo["objects"].values())[0]["geometries"]
for g in geoms:
    iso = g["properties"]["iso"]
    polys = g["arcs"] if g["type"] == "MultiPolygon" else [g["arcs"]]
    me = bpy.data.meshes.new(iso); ob = bpy.data.objects.new(iso, me)
    bpy.context.collection.objects.link(ob)
    bm = bmesh.new()
    for poly in polys:
        pts = [proj(p) for p in ring(poly[0])][:-1]
        if len(pts) < 3: continue
        verts = [bm.verts.new((x, y, 0)) for x, y in pts]
        try: bm.faces.new(verts)
        except ValueError: continue
    h = 0.06 + house[iso] * 0.028
    geom = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    bmesh.ops.translate(bm, vec=(0, 0, h), verts=[v for v in geom["geom"] if isinstance(v, bmesh.types.BMVert)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(me); bm.free()
    ob.data.materials.append(mats[zone[iso]])
    bev = ob.modifiers.new("bevel", "BEVEL"); bev.width = 0.012; bev.segments = 2

# ground
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
bpy.context.object.data.materials.append(mat("ground", (0.02, 0.022, 0.026), 0.0, 0.55))

# camera: low, cinematic, slightly off-axis
cam = bpy.data.cameras.new("cam"); cam.lens = 55; cam.dof.use_dof = True; cam.dof.aperture_fstop = 2.2
co = bpy.data.objects.new("cam", cam); bpy.context.collection.objects.link(co); scene.camera = co
co.location = (3.8, -11.5, 5.2)
target = bpy.data.objects.new("target", None); bpy.context.collection.objects.link(target); target.location = (0.3, 0.6, 0.4)
tc = co.constraints.new("TRACK_TO"); tc.target = target; tc.track_axis = "TRACK_NEGATIVE_Z"; tc.up_axis = "UP_Y"
cam.dof.focus_object = target

def area(name, loc, energy, rgb, size):
    l = bpy.data.lights.new(name, "AREA"); l.energy = energy; l.color = rgb; l.size = size
    o = bpy.data.objects.new(name, l); o.location = loc; bpy.context.collection.objects.link(o)
    t = o.constraints.new("TRACK_TO"); t.target = target; t.track_axis = "TRACK_NEGATIVE_Z"; t.up_axis = "UP_Y"
area("key", (-6, -6, 7), 2600, (1.0, 0.72, 0.45), 4)
area("rim", (6, 7, 3), 1800, (0.35, 0.55, 1.0), 3)
area("fill", (0, -12, 2), 300, (1.0, 0.9, 0.8), 6)
world = bpy.data.worlds.new("w"); world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.01, 0.011, 0.014, 1); world.node_tree.nodes["Background"].inputs[1].default_value = 0.4
scene.world = world

scene.render.filepath = OUT
bpy.ops.render.render(write_still=True)
print("RENDERED", OUT)
