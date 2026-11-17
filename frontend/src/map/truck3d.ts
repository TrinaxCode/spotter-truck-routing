import * as maplibregl from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { TruckPosition } from "./handle";

export const TRUCK_3D_LAYER = "truck-3d";

/** Body length of the model in metres (tractor + 53 ft trailer). */
const MODEL_LENGTH_M = 21;
/** On-screen length the truck keeps at every zoom; a real-size truck is invisible at route zoom. */
const SCREEN_LENGTH_PX = 150;
/** In the trip overview (whole route on screen) the truck is a marker, not the subject. */
const OVERVIEW_LENGTH_PX = 44;
const OVERVIEW_ZOOM = 6;
const CHASE_ZOOM = 10;

/** On-screen length for a zoom: small over the whole route, full size in the chase view. */
export function screenLengthPx(zoom: number): number {
  const t = Math.min(1, Math.max(0, (zoom - OVERVIEW_ZOOM) / (CHASE_ZOOM - OVERVIEW_ZOOM)));
  const eased = t * t * (3 - 2 * t);
  return OVERVIEW_LENGTH_PX + (SCREEN_LENGTH_PX - OVERVIEW_LENGTH_PX) * eased;
}
/** Mercator metres per CSS pixel at zoom 0 on the equator for 512 px tiles. */
const METERS_PER_PX_Z0 = 40_075_016.686 / 512;
const WHEEL_RADIUS_M = 0.52;

export interface Truck3D {
  layer: CustomLayerInterface;
  /** Moves the model; null hides it. Repaints the map. */
  update: (truck: TruckPosition | null) => void;
  setAccent: (hex: string) => void;
}

interface TruckModel {
  root: THREE.Group;
  wheels: THREE.Mesh[];
  brakeLights: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial[];
}

/**
 * A long-nose conventional in local metres: +x right, +y forward (north before rotation),
 * +z up, origin on the tractor's rear frame. Procedural: no model download or licence.
 */
function buildTruck(accentHex: string): TruckModel {
  const root = new THREE.Group();
  root.name = "class-8-conventional";
  const paint = new THREE.MeshPhysicalMaterial({
    name: "clearcoat-paint", color: accentHex, metalness: 0.28, roughness: 0.3,
    clearcoat: 0.9, clearcoatRoughness: 0.22,
  });
  const trailerSkin = new THREE.MeshStandardMaterial({ name: "trailer-shell", color: 0xe8edef, metalness: 0.18, roughness: 0.48 });
  const doors = new THREE.MeshStandardMaterial({ name: "door-panels", color: 0xd0dadd, metalness: 0.2, roughness: 0.48 });
  // A little diffuse response keeps chrome readable without an environment-map download.
  const chrome = new THREE.MeshStandardMaterial({ name: "chrome", color: 0xc9d7e0, metalness: 0.58, roughness: 0.23 });
  const ribs = new THREE.MeshStandardMaterial({ name: "aluminum-ribs", color: 0xa2b2bd, metalness: 0.4, roughness: 0.42 });
  const chassis = new THREE.MeshStandardMaterial({ name: "chassis", color: 0x25313c, metalness: 0.25, roughness: 0.65 });
  const rubber = new THREE.MeshStandardMaterial({ name: "rubber", color: 0x141b23, roughness: 0.88 });
  const glass = new THREE.MeshPhysicalMaterial({ name: "tinted-glass", color: 0x102837, metalness: 0.3, roughness: 0.16, clearcoat: 1 });
  const headlight = new THREE.MeshStandardMaterial({ name: "headlights", color: 0xf3f9ff, emissive: 0xc8e8ff, emissiveIntensity: 1.8 });
  const amber = new THREE.MeshStandardMaterial({ name: "amber-markers", color: 0xffb238, emissive: 0xff8a16, emissiveIntensity: 0.9 });
  const red = new THREE.MeshStandardMaterial({ name: "reflectors", color: 0xc7353b, emissive: 0x901b20, emissiveIntensity: 0.35 });
  const brakeLights = new THREE.MeshStandardMaterial({ name: "brake-lights", color: 0xb51d2d, emissive: 0xff1826, emissiveIntensity: 0.25 });

  // Bake static hardware into one draw per material. Primitives and wheel assemblies are
  // shared; only tires/hubs remain separate so playback can rotate them without rebuilding.
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const unitBox = new THREE.BoxGeometry().toNonIndexed();
  const rounded = new RoundedBoxGeometry(1, 1, 1, 2, 0.12);
  const unitCylinder = new THREE.CylinderGeometry(1, 1, 1, 16).toNonIndexed();
  const transform = new THREE.Object3D();
  const part = (
    geometry: THREE.BufferGeometry, material: THREE.Material,
    w: number, l: number, h: number, x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ) => {
    transform.position.set(x, y, z);
    transform.scale.set(w, l, h);
    transform.rotation.set(rx, ry, rz);
    transform.updateMatrix();
    const baked = geometry.clone().applyMatrix4(transform.matrix);
    const bucket = parts.get(material);
    if (bucket) bucket.push(baked);
    else parts.set(material, [baked]);
  };
  const box = (
    w: number, l: number, h: number, material: THREE.Material,
    x: number, y: number, bottom: number, soft = false, rx = 0,
  ) => part(soft ? rounded : unitBox, material, w, l, h, x, y, bottom + h / 2, rx);
  const cylinder = (
    radius: number, length: number, material: THREE.Material,
    x: number, y: number, z: number, axis: "x" | "y" | "z" = "z",
  ) => part(unitCylinder, material, radius, length, radius, x, y, z, axis === "z" ? Math.PI / 2 : 0, 0, axis === "x" ? Math.PI / 2 : 0);

  // Independent tractor rails, catwalk and the exposed fifth-wheel coupling. The van's
  // front overhang sits above the drive tandem, as on a real 53 ft combination.
  for (const side of [-1, 1]) {
    box(0.18, 8.1, 0.26, chassis, side * 0.48, 2.05, 0.72);
    box(0.12, 15.8, 0.22, chassis, side * 0.87, -6.45, 0.96);
  }
  box(1.72, 1.5, 0.08, chrome, 0, 1.05, 1.02);
  cylinder(0.72, 0.12, chassis, 0, 1.05, 1.17);
  box(0.13, 0.85, 0.13, rubber, 0, 1.2, 1.19); // coupling slot

  // True 53 ft (16.15 m) van; subdued ribs and perimeter rails survive the small screen size.
  box(2.6, 16.15, 2.87, trailerSkin, 0, -6.475, 1.3);
  for (const side of [-1, 1]) {
    box(0.065, 16.15, 0.09, chrome, side * 1.31, -6.475, 4.08);
    box(0.07, 16.15, 0.14, chrome, side * 1.31, -6.475, 1.28);
    box(0.04, 15.9, 0.11, paint, side * 1.35, -6.475, 1.6);
    // The corrugation is geometry rather than an aliased high-frequency normal texture.
    for (let i = 0; i < 35; i++) {
      box(0.026, 0.038, 2.35, ribs, side * 1.308, 1.3 - i * 0.45, 1.72);
    }
    box(0.08, 7.8, 0.6, doors, side * 1.17, -5.7, 0.65, true); // aerodynamic skirt
    box(0.09, 7.7, 0.07, chassis, side * 1.19, -5.7, 0.65);
    for (let i = 0; i < 17; i++) {
      box(0.018, 0.34, 0.075, i % 2 === 0 ? red : doors, side * 1.352, 1.1 - i * 0.94, 1.32);
    }
    for (const y of [1.4, -5.1, -14.3]) box(0.05, 0.18, 0.11, amber, side * 1.36, y, 1.47);
    // Retracted landing legs, cranks and footplates, forward of the skirts.
    cylinder(0.075, 0.78, chassis, side * 0.91, -1.65, 0.83);
    box(0.36, 0.4, 0.08, chrome, side * 0.91, -1.65, 0.42);
    box(0.34, 0.06, 0.06, chrome, side * 1.02, -1.5, 0.95);
  }

  // Rear portal: inset twin doors, gasket, lock rods, three hinges per door and underride bar.
  box(2.63, 0.055, 2.91, chassis, 0, -14.57, 1.28);
  for (const side of [-1, 1]) {
    box(1.225, 0.045, 2.66, doors, side * 0.635, -14.61, 1.48);
    cylinder(0.031, 2.42, chrome, side * 0.58, -14.65, 2.8);
    box(0.23, 0.08, 0.055, chrome, side * 0.49, -14.69, 2.05);
    for (const z of [1.66, 2.76, 3.87]) {
      box(0.21, 0.09, 0.09, chrome, side * 1.16, -14.66, z);
      box(0.1, 0.075, 0.09, ribs, side * 0.58, -14.68, z);
    }
    box(0.08, 0.1, 2.9, chrome, side * 1.28, -14.62, 1.29);
    box(0.7, 0.14, 0.22, rubber, side * 0.88, -14.57, 1.12);
    for (const offset of [-0.17, 0.17]) cylinder(0.087, 0.035, brakeLights, side * 0.88 + offset, -14.66, 1.23, "y");
    box(0.73, 0.06, 0.48, rubber, side * 0.95, -13.72, 0.24); // tandem mud flaps
    box(0.7, 0.07, 0.06, chrome, side * 0.95, -13.76, 0.61);
    box(0.09, 0.13, 0.54, chassis, side * 0.87, -14.37, 0.49);
  }
  box(2.65, 0.13, 0.1, chrome, 0, -14.62, 4.12);
  box(2.55, 0.12, 0.11, chrome, 0, -14.65, 1.37);
  box(2.5, 0.16, 0.16, chrome, 0, -14.39, 0.4);
  for (let i = 0; i < 8; i++) box(0.28, 0.02, 0.075, i % 2 ? red : doors, -0.98 + i * 0.28, -14.74, 1.39);
  for (const x of [-0.22, 0, 0.22]) box(0.1, 0.055, 0.09, red, x, -14.7, 4.13);

  // Sculpted sleeper and cab. The roof rises toward the van; the hood narrows and drops
  // toward the grille instead of looking like another cargo box.
  box(2.36, 1.85, 2.49, paint, 0, 2.85, 1.03, true);
  box(2.24, 1.66, 2.02, paint, 0, 3.99, 1.03, true);
  const fairing = rounded.clone();
  const fairingPositions = fairing.getAttribute("position");
  for (let i = 0; i < fairingPositions.count; i++) {
    const y = fairingPositions.getY(i);
    fairingPositions.setZ(i, fairingPositions.getZ(i) - 0.42 * y);
  }
  fairing.computeVertexNormals();
  part(fairing, paint, 2.32, 2.45, 0.78, 0, 3.16, 3.6);
  const hood = rounded.clone();
  const hoodPositions = hood.getAttribute("position");
  for (let i = 0; i < hoodPositions.count; i++) {
    const y = hoodPositions.getY(i);
    hoodPositions.setX(i, hoodPositions.getX(i) * (0.88 - 0.24 * y));
    hoodPositions.setZ(i, hoodPositions.getZ(i) - 0.16 * y);
  }
  hood.computeVertexNormals();
  part(hood, paint, 1.92, 1.92, 1.18, 0, 5.36, 1.65);
  box(0.075, 1.78, 0.025, chrome, 0, 5.34, 2.24); // hood centre trim
  box(1.48, 0.12, 1.22, chrome, 0, 6.27, 0.99, true);
  box(1.27, 0.035, 0.99, rubber, 0, 6.34, 1.1);
  for (let i = 0; i < 11; i++) box(0.045, 0.045, 0.91, chrome, -0.57 + i * 0.114, 6.37, 1.14);
  box(1.28, 0.055, 0.065, chrome, 0, 6.37, 1.58);
  box(0.17, 0.055, 0.09, paint, 0, 6.41, 2.02);
  box(2.58, 0.29, 0.29, chrome, 0, 6.305, 0.59, true);
  box(0.45, 0.025, 0.13, chassis, 0, 6.46, 0.66);

  // A raked split windshield, black seal and chrome sun visor. Side windows, door seams,
  // mirror arms and entry steps establish scale even when the trailer hides most of the cab.
  box(2.03, 0.065, 0.88, rubber, 0, 4.74, 2.2, true, 0.16);
  for (const side of [-1, 1]) {
    box(0.93, 0.078, 0.72, glass, side * 0.493, 4.79, 2.27, true, 0.16);
    box(0.035, 1.1, 0.76, rubber, side * 1.125, 3.99, 2.24, true);
    box(0.043, 0.97, 0.65, glass, side * 1.147, 4.01, 2.3, true);
    box(0.026, 0.55, 0.44, rubber, side * 1.183, 2.45, 2.63, true);
    box(0.04, 0.45, 0.33, glass, side * 1.201, 2.45, 2.68, true);
    box(0.025, 0.035, 1.1, ribs, side * 1.126, 3.4, 1.22);
    box(0.047, 0.22, 0.06, chrome, side * 1.15, 3.65, 2.08);
    box(0.045, 2.9, 0.08, chrome, side * 1.18, 3.1, 1.78);
    box(0.07, 1.42, 0.35, paint, side * 1.12, 3.94, 1.03, true);
    box(0.32, 1.1, 0.13, chrome, side * 1.23, 3.77, 0.69);
    box(0.24, 0.95, 0.13, chrome, side * 1.2, 3.77, 0.91);
    cylinder(0.31, 1.65, chrome, side * 1.02, 2.38, 0.85, "y");
    for (const y of [1.8, 2.94]) cylinder(0.318, 0.075, chassis, side * 1.02, y, 0.85, "y");
    cylinder(0.105, 2.5, chrome, side * 1.26, 1.62, 2.5);
    cylinder(0.15, 1.12, chrome, side * 1.26, 1.62, 1.65); // heat shield
    cylinder(0.078, 0.025, rubber, side * 1.26, 1.62, 3.76); // open stack cap
    box(0.37, 0.055, 0.055, chrome, side * 1.31, 4.36, 2.75);
    box(0.16, 0.25, 0.48, chrome, side * 1.5, 4.36, 2.56, true);
    box(0.02, 0.19, 0.34, glass, side * 1.59, 4.36, 2.64, true);
    // Rounded steer fenders and separate LED headlight pods beside the tall grille.
    box(0.48, 1.68, 0.3, paint, side * 1.02, 5.25, 1.02, true);
    box(0.46, 0.18, 0.33, chrome, side * 1.01, 6.16, 1.04, true);
    box(0.35, 0.035, 0.2, rubber, side * 1.01, 6.26, 1.1, true);
    for (const dx of [-0.095, 0.095]) box(0.13, 0.045, 0.11, headlight, side * 1.01 + dx, 6.29, 1.16, true);
    box(0.13, 0.05, 0.065, amber, side * 1.17, 6.27, 1.31);
    box(0.73, 2.45, 0.14, chassis, side * 0.96, -0.5, 1.07, true); // drive fenders
    box(0.73, 0.06, 0.44, rubber, side * 0.95, -1.91, 0.32);
  }
  box(2.28, 0.35, 0.095, chrome, 0, 4.7, 3.09, true, 0.12);
  for (const x of [-0.84, -0.42, 0, 0.42, 0.84]) {
    box(0.17, 0.23, 0.075, chrome, x, 4.48, 3.12, true);
    box(0.12, 0.15, 0.065, amber, x, 4.5, 3.18, true);
  }

  // 18 tires: two steer singles, eight drive tires, eight trailer tires. A lathed profile
  // rounds the shoulders. All use a local Y axle, turned onto X before spinning around X.
  const wheels: THREE.Mesh[] = [];
  const wheelGeometry = new THREE.LatheGeometry([
    new THREE.Vector2(0.29, -0.16), new THREE.Vector2(0.42, -0.16),
    new THREE.Vector2(0.5, -0.125), new THREE.Vector2(WHEEL_RADIUS_M, -0.075),
    new THREE.Vector2(WHEEL_RADIUS_M, 0.075), new THREE.Vector2(0.5, 0.125),
    new THREE.Vector2(0.42, 0.16), new THREE.Vector2(0.29, 0.16),
  ], 24);
  const hubGeometry = new THREE.LatheGeometry([
    new THREE.Vector2(0, -0.215), new THREE.Vector2(0.1, -0.215),
    new THREE.Vector2(0.12, -0.17), new THREE.Vector2(0.27, -0.17),
    new THREE.Vector2(0.295, -0.145), new THREE.Vector2(0.295, 0.145),
    new THREE.Vector2(0.27, 0.17), new THREE.Vector2(0.12, 0.17),
    new THREE.Vector2(0.1, 0.215), new THREE.Vector2(0, 0.215),
  ], 24);
  // Six dark hand holes break up the chrome discs and make their spin visible.
  const holeParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const hole = new THREE.CylinderGeometry(0.048, 0.048, 0.35, 8);
    hole.translate(Math.sin(a) * 0.215, 0, Math.cos(a) * 0.215);
    holeParts.push(hole);
  }
  const holesGeometry = mergeGeometries(holeParts)!;
  holeParts.forEach((g) => g.dispose());
  for (const axleY of [5.18, 0.05, -1.3, -11.65, -13.0]) {
    cylinder(0.1, 2.3, chassis, 0, axleY, WHEEL_RADIUS_M, "x");
    for (const side of [-1, 1]) {
      for (const offset of axleY === 5.18 ? [1.12] : [0.84, 1.19]) {
        const wheel = new THREE.Mesh(wheelGeometry, rubber);
        wheel.name = "tire";
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * offset, axleY, WHEEL_RADIUS_M);
        wheel.add(new THREE.Mesh(hubGeometry, chrome), new THREE.Mesh(holesGeometry, chassis));
        root.add(wheel);
        wheels.push(wheel);
      }
    }
  }
  for (const [material, geometries] of parts) {
    const mesh = new THREE.Mesh(mergeGeometries(geometries)!, material);
    mesh.name = material.name;
    root.add(mesh);
    geometries.forEach((geometry) => geometry.dispose());
  }
  for (const geometry of [unitBox, rounded, unitCylinder, hood, fairing]) geometry.dispose();

  // Soft contact shadow so the truck sits on the map instead of floating over it.
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const ctx = shadowCanvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    gradient.addColorStop(0, "rgba(8,15,23,0.6)");
    gradient.addColorStop(0.6, "rgba(8,15,23,0.35)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.5, 23),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowCanvas),
      transparent: true,
      depthWrite: false,
    }),
  );
  shadow.name = "contact-shadow";
  shadow.position.set(0, -4.1, 0.015);
  root.add(shadow);

  return { root, wheels, brakeLights, accent: [paint] };
}

/**
 * MapLibre custom layer (renderingMode "3d") that draws the playback truck with three.js on the
 * map's own WebGL context. The model is rebuilt only on creation; per frame we write one matrix.
 */
export function createTruck3D(map: maplibregl.Map, accentHex: string): Truck3D {
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const model = buildTruck(accentHex);
  model.root.visible = false;
  scene.add(model.root);
  const sky = new THREE.HemisphereLight(0xe4efff, 0x59616b, 2.1);
  sky.position.set(0, 0, 1); // The model is Z-up, unlike three.js's default hemisphere.
  scene.add(sky);
  const sun = new THREE.DirectionalLight(0xfff4e4, 2.5);
  sun.position.set(-0.6, 0.8, 1.4);
  scene.add(sun);

  let renderer: THREE.WebGLRenderer | null = null;
  let truck: TruckPosition | null = null;
  let rolled = 0;
  let hasLast = false;
  let lastLon = 0;
  let lastLat = 0;
  const origin = new maplibregl.MercatorCoordinate(0, 0, 0);
  const local = new THREE.Matrix4();
  const rotation = new THREE.Matrix4();
  const inverseProjection = new THREE.Matrix4();
  const scale = new THREE.Vector3();

  const layer: CustomLayerInterface = {
    id: TRUCK_3D_LAYER,
    type: "custom",
    renderingMode: "3d",
    onAdd(_map, gl) {
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
    },
    onRemove() {
      renderer?.dispose();
      renderer = null;
    },
    render(_gl, args: CustomRenderMethodInput) {
      if (!renderer || !truck) return;
      const metersPerPx = (METERS_PER_PX_Z0 * Math.cos((truck.lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const exaggeration = Math.max(1, (screenLengthPx(map.getZoom()) * metersPerPx) / MODEL_LENGTH_M);
      const s = origin.meterInMercatorCoordinateUnits() * exaggeration;
      // Mercator y grows southwards; the negative y scale turns the model's +y into north.
      local.makeTranslation(origin.x, origin.y, origin.z).scale(scale.set(s, -s, s));
      local.multiply(rotation.makeRotationZ((-truck.bearing * Math.PI) / 180));
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(local);
      // Baking the map's full view into projection alone leaves three.js's camera eye at
      // ground level, so PBR/clearcoat sees the roof from below. The inverse's third column
      // is the perspective eye in model space (homogeneous w); undo that view translation
      // in projection so screen coordinates remain exactly mainMatrix * local.
      inverseProjection.copy(camera.projectionMatrix).invert();
      const eye = inverseProjection.elements;
      if (Math.abs(eye[11]) > 1e-12) camera.position.set(eye[8] / eye[11], eye[9] / eye[11], eye[10] / eye[11]);
      else camera.position.set(0, 0, 0); // Orthographic projection has its eye at infinity.
      camera.updateMatrixWorld();
      camera.projectionMatrix.multiply(camera.matrixWorld);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  };

  return {
    layer,
    update(next) {
      truck = next;
      model.root.visible = next !== null;
      if (next) {
        // Equivalent to MercatorCoordinate.fromLngLat, writing into a reused coordinate
        // rather than allocating a LngLat, coordinate and tuple on every animation frame.
        origin.x = (180 + next.lon) / 360;
        origin.y = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + next.lat * Math.PI / 360))) / 360;
        if (hasLast && !next.stopped && (next.lon !== lastLon || next.lat !== lastLat)) {
          // Playback covers dozens of miles per second, so real wheel speed would alias; a steady
          // visual spin while the truck moves reads correctly instead.
          rolled -= 0.45;
          for (const wheel of model.wheels) wheel.rotation.x = rolled;
        }
        model.brakeLights.emissiveIntensity = next.stopped ? 2.4 : 0.25;
        lastLon = next.lon;
        lastLat = next.lat;
        hasLast = true;
      } else {
        hasLast = false;
      }
      map.triggerRepaint();
    },
    setAccent(hex) {
      for (const material of model.accent) material.color.set(hex);
      map.triggerRepaint();
    },
  };
}
