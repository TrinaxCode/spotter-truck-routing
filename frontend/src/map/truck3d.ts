import * as maplibregl from "maplibre-gl";
import type { CustomLayerInterface, CustomRenderMethodInput } from "maplibre-gl";
import * as THREE from "three";
import type { TruckPosition } from "./handle";

export const TRUCK_3D_LAYER = "truck-3d";

/** Body length of the model in metres (tractor + 53 ft trailer). */
const MODEL_LENGTH_M = 21;
/** On-screen length the truck keeps at every zoom; a real-size truck is invisible at route zoom. */
const SCREEN_LENGTH_PX = 150;
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
 * A semi-truck built from primitives in local metres: +x east, +y forward (north before rotation),
 * +z up, origin under the fifth wheel. Procedural, so there is no model download or licence.
 */
function buildTruck(accentHex: string): TruckModel {
  const root = new THREE.Group();
  const accentColor = new THREE.Color(accentHex);
  const paint = new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.35, roughness: 0.38 });
  const paintDark = new THREE.MeshStandardMaterial({
    color: accentColor.clone().multiplyScalar(0.62),
    metalness: 0.3,
    roughness: 0.45,
  });
  const trailerSkin = new THREE.MeshStandardMaterial({ color: 0xf3f5f8, metalness: 0.15, roughness: 0.55 });
  const stripe = new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.2, roughness: 0.5 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd9dee5, metalness: 0.9, roughness: 0.22 });
  const chassis = new THREE.MeshStandardMaterial({ color: 0x1d2228, metalness: 0.4, roughness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0f1a26, metalness: 0.6, roughness: 0.08 });
  const tyre = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xb9c0c8, metalness: 0.85, roughness: 0.3 });
  const headlight = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff1c2, emissiveIntensity: 1.4 });
  const brakeLights = new THREE.MeshStandardMaterial({ color: 0x5a0d0d, emissive: 0xff2a2a, emissiveIntensity: 0.25 });

  const box = (w: number, l: number, h: number, material: THREE.Material, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, l, h), material);
    mesh.position.set(x, y, z + h / 2);
    root.add(mesh);
    return mesh;
  };

  // Frame rails under the whole rig.
  box(1.0, 19.4, 0.32, chassis, 0, -3.6, 0.78);

  // Trailer: 2.6 m wide box with a stripe and a darker skirt line.
  box(2.6, 13.4, 2.9, trailerSkin, 0, -6.9, 1.25);
  box(2.62, 13.42, 0.34, stripe, 0, -6.9, 2.35);
  box(2.62, 13.42, 0.08, paintDark, 0, -6.9, 1.25);
  box(2.0, 6.0, 0.55, chassis, 0, -6.2, 0.7); // side skirts read as a solid underside

  // Tractor: sleeper, cab, hood and roof fairing.
  box(2.5, 1.9, 2.75, paint, 0, 1.55, 1.0); // sleeper
  box(2.5, 1.9, 2.35, paint, 0, 3.4, 1.0); // cab
  box(2.3, 1.9, 1.2, paintDark, 0, 5.2, 0.95); // hood
  box(2.32, 0.3, 0.9, chrome, 0, 6.25, 0.95); // grille
  const fairing = new THREE.Mesh(new THREE.BoxGeometry(2.48, 1.6, 0.7), paint);
  fairing.position.set(0, 2.7, 4.05);
  fairing.rotation.x = -0.32;
  root.add(fairing);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.08, 1.05), glass);
  windshield.position.set(0, 4.36, 2.85);
  windshield.rotation.x = -0.28;
  root.add(windshield);
  for (const side of [-1, 1]) {
    const window = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.8), glass);
    window.position.set(side * 1.26, 3.55, 2.75);
    root.add(window);
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 2.6, 12), chrome);
    stack.rotation.x = Math.PI / 2;
    stack.position.set(side * 1.12, 0.5, 3.0);
    root.add(stack);
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.5), chrome);
    mirror.position.set(side * 1.42, 4.3, 2.75);
    root.add(mirror);
    box(0.36, 0.08, 0.22, headlight, side * 0.88, 6.42, 1.25);
    box(0.34, 0.08, 0.2, brakeLights, side * 1.05, -13.62, 1.4);
  }
  box(2.4, 0.4, 0.35, chrome, 0, 6.35, 0.55); // bumper

  // Wheels: steer axle, tandem drive axles, tandem trailer axles.
  const wheels: THREE.Mesh[] = [];
  const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS_M, WHEEL_RADIUS_M, 0.42, 20);
  const hubGeometry = new THREE.CylinderGeometry(0.26, 0.26, 0.44, 12);
  for (const axleY of [5.25, 0.9, -0.45, -10.4, -11.75]) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Mesh(wheelGeometry, tyre);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(side * 1.08, axleY, WHEEL_RADIUS_M);
      const hub = new THREE.Mesh(hubGeometry, rim);
      wheel.add(hub);
      root.add(wheel);
      wheels.push(wheel);
    }
  }

  // Soft contact shadow so the truck sits on the map instead of floating over it.
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = 64;
  shadowCanvas.height = 256;
  const ctx = shadowCanvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(32, 128, 4, 32, 128, 128);
    gradient.addColorStop(0, "rgba(0,0,0,0.55)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.save();
    ctx.scale(1, 1);
    ctx.fillRect(0, 0, 64, 256);
    ctx.restore();
  }
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 23),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(shadowCanvas),
      transparent: true,
      depthWrite: false,
    }),
  );
  shadow.position.set(0, -3.6, 0.02);
  root.add(shadow);

  return { root, wheels, brakeLights, accent: [paint, stripe] };
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
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a3f46, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-0.6, 0.8, 1.4);
  scene.add(sun);

  let renderer: THREE.WebGLRenderer | null = null;
  let truck: TruckPosition | null = null;
  let rolled = 0;
  let last: { lon: number; lat: number } | null = null;
  const local = new THREE.Matrix4();
  const rotation = new THREE.Matrix4();
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
      const origin = maplibregl.MercatorCoordinate.fromLngLat([truck.lon, truck.lat], 0);
      const metersPerPx = (METERS_PER_PX_Z0 * Math.cos((truck.lat * Math.PI) / 180)) / 2 ** map.getZoom();
      const exaggeration = Math.max(1, (SCREEN_LENGTH_PX * metersPerPx) / MODEL_LENGTH_M);
      const s = origin.meterInMercatorCoordinateUnits() * exaggeration;
      // Mercator y grows southwards; the negative y scale turns the model's +y into north.
      local.makeTranslation(origin.x, origin.y, origin.z).scale(scale.set(s, -s, s));
      local.multiply(rotation.makeRotationZ((-truck.bearing * Math.PI) / 180));
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(local);
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
        if (last && !next.stopped && (next.lon !== last.lon || next.lat !== last.lat)) {
          // Playback covers dozens of miles per second, so real wheel speed would alias; a steady
          // visual spin while the truck moves reads correctly instead.
          rolled -= 0.45;
          for (const wheel of model.wheels) wheel.rotation.x = rolled;
        }
        model.brakeLights.emissiveIntensity = next.stopped ? 2.4 : 0.25;
        last = { lon: next.lon, lat: next.lat };
      } else {
        last = null;
      }
      map.triggerRepaint();
    },
    setAccent(hex) {
      for (const material of model.accent) material.color.set(hex);
      map.triggerRepaint();
    },
  };
}
