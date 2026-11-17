import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import * as maplibregl from "maplibre-gl";
import type { CustomRenderMethodInput } from "maplibre-gl";
import { createTruck3D, TRUCK_3D_LAYER } from "./truck3d";

const capture = vi.hoisted(() => ({
  scene: null as THREE.Scene | null,
  camera: null as THREE.Camera | null,
}));

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      autoClear = true;
      resetState() {}
      dispose() {}
      render(scene: THREE.Scene, camera: THREE.Camera) {
        scene.updateMatrixWorld(true);
        capture.scene = scene;
        capture.camera = camera;
      }
    },
  };
});

beforeEach(() => {
  capture.scene = null;
  capture.camera = null;
  // Texture pixels are inspected in Chromium; jsdom only needs the canvas API.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    save() {},
    scale() {},
    restore() {},
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => vi.restoreAllMocks());

function setup() {
  let zoom = 12;
  const map = {
    getCanvas: () => document.createElement("canvas"),
    getZoom: () => zoom,
    triggerRepaint: vi.fn(),
  } as unknown as maplibregl.Map;
  const truck = createTruck3D(map, "#99cc22");
  const gl = {} as WebGL2RenderingContext;
  truck.layer.onAdd?.(map, gl);
  const position = { lon: -96.797, lat: 32.7767, bearing: 0, stopped: false };
  const render = (projection = new THREE.Matrix4()) => {
    truck.layer.render(gl, {
      defaultProjectionData: { mainMatrix: projection.elements },
    } as unknown as CustomRenderMethodInput);
  };
  truck.update(position);
  render();
  const root = capture.scene!.children.find((o) => o instanceof THREE.Group)!;
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
  const wheels = meshes.filter((m) => m.name === "tire");
  return { truck, root, meshes, wheels, render, position, setZoom: (value: number) => { zoom = value; } };
}

describe("procedural Class 8 truck", () => {
  it("has a 53 ft dry van, 18 grounded tires, and fewer than 400 meshes", () => {
    const { truck, root, meshes, wheels } = setup();
    expect(truck.layer.id).toBe(TRUCK_3D_LAYER);
    expect(truck.layer.renderingMode).toBe("3d");
    const trailer = root.getObjectByName("trailer-shell");
    expect(trailer).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(trailer!);
    expect(bounds.max.y - bounds.min.y).toBeCloseTo(16.15, 2);
    expect(meshes.length).toBeLessThan(400);
    expect(wheels).toHaveLength(18);
    const axles = new Map<number, number>();
    for (const wheel of wheels) {
      const tire = new THREE.Box3().setFromObject(wheel);
      expect(tire.min.z).toBeCloseTo(0, 3);
      axles.set(wheel.position.y, (axles.get(wheel.position.y) ?? 0) + 1);
    }
    expect([...axles.values()].sort()).toEqual([2, 4, 4, 4, 4]);
    expect(new Set(wheels.map((w) => w.geometry)).size).toBe(1);
    expect(new THREE.Box3().setFromObject(root.getObjectByName("headlights")!).min.y).toBeGreaterThan(6);
    expect(new THREE.Box3().setFromObject(root.getObjectByName("brake-lights")!).max.y).toBeLessThan(-14);
    const sky = capture.scene!.children.find((o) => o instanceof THREE.HemisphereLight)!;
    expect(sky.position.z).toBeGreaterThan(0);
    const shadow = root.getObjectByName("contact-shadow") as THREE.Mesh;
    expect(shadow.position.z).toBeGreaterThan(0);
    expect((shadow.material as THREE.MeshBasicMaterial).depthWrite).toBe(false);
  });

  it("recolors every clearcoat paint surface and keeps the trailer neutral", () => {
    const { truck, meshes } = setup();
    const paint = meshes.map((m) => m.material).filter((m): m is THREE.MeshPhysicalMaterial => m instanceof THREE.MeshPhysicalMaterial && m.name === "clearcoat-paint");
    expect(paint.length).toBeGreaterThan(0);
    truck.setAccent("#dd7722");
    for (const material of paint) {
      expect(material.color.getHexString()).toBe("dd7722");
      expect(material.clearcoat).toBeGreaterThan(0.5);
    }
    const trailer = meshes.find((m) => m.name === "trailer-shell")!;
    expect((trailer.material as THREE.MeshStandardMaterial).color.getHexString()).not.toBe("dd7722");
  });

  it("spins around the transverse axle only while moving and brightens brake lights at a stop", () => {
    const { truck, wheels, meshes, render, position } = setup();
    expect(wheels).toHaveLength(18);
    const brake = meshes.map((m) => m.material).find((m) => !Array.isArray(m) && m.name === "brake-lights") as THREE.MeshStandardMaterial;
    expect(brake).toBeDefined();
    const initial = wheels[0].rotation.x;
    truck.update({ ...position, lon: position.lon + 0.001 });
    render();
    expect(wheels[0].rotation.x).toBeLessThan(initial);
    for (const wheel of wheels) {
      const axle = new THREE.Vector3(0, 1, 0).applyQuaternion(wheel.quaternion);
      expect(Math.abs(axle.x)).toBeCloseTo(1);
      expect(axle.y).toBeCloseTo(0);
      expect(axle.z).toBeCloseTo(0);
    }
    const moving = wheels[0].rotation.x;
    truck.update({ ...position, stopped: true });
    expect(wheels[0].rotation.x).toBe(moving);
    expect(brake.emissiveIntensity).toBe(2.4);
    truck.update(position);
    expect(brake.emissiveIntensity).toBe(0.25);
    truck.update(null);
    expect(capture.scene!.children.find((o) => o instanceof THREE.Group)!.visible).toBe(false);
  });

  it("uses mainMatrix and keeps +Y pointing along cardinal bearings under the Mercator reflection", () => {
    const { truck, render, position } = setup();
    const origin = maplibregl.MercatorCoordinate.fromLngLat([position.lon, position.lat]);
    for (const bearing of [0, 90, 180, 270]) {
      truck.update({ ...position, bearing });
      const mainMatrix = new THREE.Matrix4().makeTranslation(0.2, -0.1, 0.3);
      render(mainMatrix);
      const local = mainMatrix.clone().invert().multiply(capture.camera!.projectionMatrix)
        .multiply(capture.camera!.matrixWorldInverse);
      const forward = new THREE.Vector3(0, 1, 0).transformDirection(local);
      expect(forward.x).toBeCloseTo(Math.sin(bearing * Math.PI / 180));
      expect(forward.y).toBeCloseTo(-Math.cos(bearing * Math.PI / 180));
      expect(new THREE.Vector3(0, 0, 1).transformDirection(local).z).toBeCloseTo(1);
      expect(local.elements[12]).toBeCloseTo(origin.x);
      expect(local.elements[13]).toBeCloseTo(origin.y);
      expect(local.determinant()).toBeLessThan(0);
    }
  });

  it("recovers the real local camera eye for clearcoat lighting without changing projected geometry", () => {
    const { render, position } = setup();
    const mapCamera = new THREE.PerspectiveCamera(40, 1.5, 1e-7, 2);
    const origin = maplibregl.MercatorCoordinate.fromLngLat([position.lon, position.lat]);
    mapCamera.up.set(0, 0, 1);
    mapCamera.position.set(origin.x, origin.y + 0.0001, 0.0001);
    mapCamera.lookAt(origin.x, origin.y, 0);
    mapCamera.updateMatrixWorld(true);
    const main = mapCamera.projectionMatrix.clone().multiply(mapCamera.matrixWorldInverse);
    render(main);
    // The local camera must be behind and above the truck, rather than at (0,0,0).
    expect(capture.camera!.position.y).toBeLessThan(-1);
    expect(capture.camera!.position.z).toBeGreaterThan(1);
    const metersPerPx = (40_075_016.686 / 512 * Math.cos(position.lat * Math.PI / 180)) / 2 ** 12;
    const s = origin.meterInMercatorCoordinateUnits() * (150 * metersPerPx / 21);
    const local = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0)
      .scale(new THREE.Vector3(s, -s, s));
    const expected = main.clone().multiply(local);
    const effective = capture.camera!.projectionMatrix.clone().multiply(capture.camera!.matrixWorldInverse);
    effective.elements.forEach((n, i) => expect(n).toBeCloseTo(expected.elements[i], 7));
  });

  it("preserves screen sizing across zooms and reuses the same model resources", () => {
    const { truck, root, meshes, render, position, setZoom } = setup();
    const resources = meshes.map((mesh) => [mesh.geometry, mesh.material]);
    const scale = () => new THREE.Vector3(1, 0, 0).applyMatrix4(capture.camera!.projectionMatrix)
      .distanceTo(new THREE.Vector3().applyMatrix4(capture.camera!.projectionMatrix));
    const before = scale();
    setZoom(13);
    truck.update({ ...position, lon: position.lon + 0.001 });
    render();
    expect(scale() / before).toBeCloseTo(0.5);
    expect(capture.scene!.children).toContain(root);
    meshes.forEach((mesh, i) => {
      expect(mesh.geometry).toBe(resources[i][0]);
      expect(mesh.material).toBe(resources[i][1]);
    });
  });
});
