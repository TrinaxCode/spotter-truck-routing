/**
 * Animated weather on top of the heatmap: wind that streams, rain that falls, snow that drifts.
 *
 * Particles live on the ground (Web Mercator) and are projected to the screen through a homography
 * fitted from four unprojected screen points per camera change, so pan, zoom, bearing and pitch
 * (the 3D chase view) stay correct and per-particle projection costs a few flops. Wind trails are
 * stored as short position histories and re-projected every frame, so they survive camera motion
 * (a screen-space fade buffer cannot). Everything is drawn with Canvas 2D into one off-screen
 * canvas that is composited either by a MapLibre custom layer (so it sits under route lines and
 * labels: `mode: "layer"`, the default) or by a DOM canvas over the map (`mode: "overlay"`).
 *
 * Budget: <= 4,000 particles, no allocation per frame (typed arrays, pre-built colour strings),
 * paused when the tab is hidden / the layer is invisible / reduced motion is on, and scaled down on
 * weak devices or when frames get expensive. See src/lib/windField.ts for the math.
 */
import type { CustomLayerInterface, Map as MapLibreMap } from "maplibre-gl";
import type { HeatmapResponse, HeatVariable } from "../api/types";
import {
  buildGrid,
  clamp,
  copyField,
  createField,
  createParticleSet,
  createRng,
  createScreenMapping,
  createSpawnTable,
  easeField,
  fillField,
  fillSpawnTable,
  fitScreenMapping,
  groundToScreen,
  latToMercY,
  lonToMercX,
  mercXToLon,
  mercYToLat,
  particleBudget,
  PRECIP_BUCKETS,
  precipBucket,
  precipBucketValue,
  precipIntensity,
  rainStreakPx,
  rampRgb,
  resetParticles,
  samplePrecip,
  sampleWind,
  slotLat,
  slotLon,
  smoothstep,
  SPEED_BUCKETS,
  speedBucket,
  speedBucketMph,
  STATE_ALIVE,
  STATE_IDLE,
  stepPrecipParticles,
  stepWindParticles,
  visualSpeedPx,
  windAlpha,
  windDensity,
  windVector,
  worldSizePx,
  type CellGrid,
  type PrecipKind,
  type PrecipSample,
  type ScreenMapping,
  type SpawnTable,
  type WindField,
  type WindSample,
} from "../lib/windField";

export type WeatherVariable = HeatVariable;
export type WeatherTheme = "light" | "dark";
export type WeatherMode = "layer" | "overlay";

export const WEATHER_LAYER_ID = "weather-animation";

export interface WeatherAnimationOptions {
  /** Polled every frame and on state changes; true freezes the animation to a still frame. */
  reducedMotion: () => boolean;
  /**
   * Layer mode only: the layer to sit directly under (the first route layer), so routes, checkpoints
   * and labels stay above the particles. May be a function, evaluated on every (re)attach.
   */
  beforeId?: string | (() => string | undefined);
  /** "layer" (default): MapLibre custom layer in the layer stack. "overlay": DOM canvas above the map. */
  mode?: WeatherMode;
  theme?: WeatherTheme;
  /** Hard cap on particles (default 4000). */
  maxParticles?: number;
  /** Lower the particle count when frames get expensive (default true). */
  adaptive?: boolean;
  /** Test hooks. */
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
  seed?: number;
}

export interface WeatherAnimationDebug {
  mode: WeatherMode;
  kind: "wind" | "rain" | "snow";
  capacity: number;
  activeParticles: number;
  aliveParticles: number;
  gain: number;
  budgetScale: number;
  running: boolean;
  reduced: boolean;
  attached: boolean;
  /** Identity handles of the reusable buffers: equal before/after setFrame means nothing was reallocated. */
  buffers: { fieldU: Float32Array | null; windX: Float64Array; precipX: Float64Array; table: Int32Array; scratch: Float32Array };
  mappingValid: boolean;
  frames: number;
  /** Smoothed CPU cost of one frame (simulation + 2D drawing), ms. */
  frameMs: number;
  realDirections: number;
}

export interface WeatherAnimation {
  /** Replaces the corridor data (null clears). Allocates; call once per plan, not per frame. */
  setData(heat: HeatmapResponse | null): void;
  /** `hour` may be fractional. Reuses every buffer. `risk` shows a subtle wind flow. */
  setFrame(hour: number, variable: WeatherVariable, visible: boolean): void;
  setTheme(theme: WeatherTheme): void;
  /** Layer mode: re-inserts the layer under `beforeId` (call after adding route layers). */
  restack(): void;
  destroy(): void;
  debug(): WeatherAnimationDebug;
}

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

const WIND_HISTORY = 11;
/** Screen px of ground covered by one wind particle at full density. */
const WIND_PX_PER_PARTICLE = 125;
const RAIN_PX_PER_PARTICLE = 180;
const SNOW_PX_PER_PARTICLE = 140;
const RAIN_FALL_HEIGHT_PX = 120;
const SNOW_FALL_HEIGHT_PX = 150;
/** Under the "risk" variable the wind is a hint, not the subject. */
const RISK_WIND_SHARE = 0.55;
const CULL_MARGIN_PX = 24;
const FADE_SECONDS = 0.45;
const FIELD_EASE_SECONDS = 0.3;
const MAX_CANVAS_PIXELS = 2_600_000;
const SPLASH_CAPACITY = 160;
const SPLASH_SECONDS = 0.3;
const TRAIL_TIERS = 3;

interface ThemeTune {
  mixWhite: number;
  mixBlack: number;
  alpha: number;
  width: number;
  composite: GlobalCompositeOperation;
}

const TUNE: Record<WeatherTheme, ThemeTune> = {
  dark: { mixWhite: 0.3, mixBlack: 0, alpha: 1, width: 1, composite: "lighter" },
  light: { mixWhite: 0, mixBlack: 0.34, alpha: 1.0, width: 1.08, composite: "source-over" },
};

const TIER_ALPHA = [1, 0.58, 0.26] as const;
const TIER_WIDTH = [1.55, 1.2, 0.85] as const;

type Kind = "wind" | "rain" | "snow";

function kindOf(variable: WeatherVariable): Kind {
  return variable === "rain" ? "rain" : variable === "snow" ? "snow" : "wind";
}

function tinted(rgb: readonly number[], tune: ThemeTune): [number, number, number] {
  const out: [number, number, number] = [rgb[0], rgb[1], rgb[2]];
  for (let c = 0; c < 3; c += 1) {
    out[c] = out[c] + (255 - out[c]) * tune.mixWhite;
    out[c] = out[c] * (1 - tune.mixBlack);
  }
  return out;
}

function rgba(rgb: readonly number[], alpha: number): string {
  return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${clamp(alpha, 0, 1).toFixed(3)})`;
}

/** Cheap deterministic hash in [0,1) of two integers, for stable static layouts. */
function hash2(a: number, b: number, salt = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(salt | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------------

interface Compositor {
  /** Called after the 2D canvas was (re)drawn. */
  markDirty(): void;
  setOpacity(opacity: number): void;
  detach(): void;
}

export function createWeatherAnimation(map: MapLibreMap, options: WeatherAnimationOptions): WeatherAnimation {
  const mode: WeatherMode = options.mode ?? "layer";
  const adaptive = options.adaptive ?? true;
  const requestFrame = options.requestFrame ?? ((cb) => window.requestAnimationFrame(cb));
  const cancelFrame = options.cancelFrame ?? ((handle) => window.cancelAnimationFrame(handle));
  const clock = options.now ?? (() => performance.now());
  const rng = createRng(options.seed ?? 0x57a1);

  let theme: WeatherTheme = options.theme ?? "dark";
  let destroyed = false;

  // --- data -----------------------------------------------------------------------------------
  let data: HeatmapResponse | null = null;
  let grid: CellGrid | null = null;
  let field: WindField | null = null;
  let target: WindField | null = null;
  let cellX = new Float64Array(0);
  let cellY = new Float64Array(0);
  let cellDy = new Float64Array(0);
  let visSlots = new Int32Array(0);
  let visArea = new Float32Array(0);
  let visCount = 0;
  let table: SpawnTable = createSpawnTable(1);

  let hour = 0;
  let variable: WeatherVariable = "risk";
  let wantVisible = false;
  let kind: Kind = "wind";
  let subtle = true;

  // --- particles ------------------------------------------------------------------------------
  const viewport0 = viewportSize();
  const capacity = particleBudget({
    width: viewport0.width,
    height: viewport0.height,
    devicePixelRatio: window.devicePixelRatio || 1,
    hardwareConcurrency: navigator.hardwareConcurrency || 4,
    maxParticles: options.maxParticles,
  });
  const windSet = createParticleSet(capacity, WIND_HISTORY, 11);
  const precipSet = createParticleSet(Math.round(capacity * 0.85), 0, 23);
  let activeCount = 0;
  let aliveCount = 0;
  let budgetScale = 1;

  // Per-frame scratch, allocated once.
  const scratch = new Float32Array(capacity * (WIND_HISTORY + 1) * 2);
  const scratchN = new Uint8Array(capacity);
  const drawIdx = new Int32Array(capacity);
  const drawBucket = new Uint8Array(capacity);
  const order = new Int32Array(capacity);
  const bucketStart = new Int32Array(Math.max(SPEED_BUCKETS, PRECIP_BUCKETS) + 1);
  const pt = new Float64Array(2);
  const splashX = new Float64Array(SPLASH_CAPACITY);
  const splashY = new Float64Array(SPLASH_CAPACITY);
  const splashAge = new Float32Array(SPLASH_CAPACITY);
  const splashLevel = new Float32Array(SPLASH_CAPACITY);
  let splashCursor = 0;

  // --- camera ---------------------------------------------------------------------------------
  const mapping: ScreenMapping = createScreenMapping();
  const camera = { w: 0, h: 0, zoom: NaN, lng: NaN, lat: NaN, bearing: NaN, pitch: NaN };
  const screenPoints = new Float64Array(8);
  const groundPoints = new Float64Array(8);
  let mercPerPx = 1 / worldSizePx(4);
  let pitchSquash = 1;
  let cssW = 1;
  let cssH = 1;
  let pixelRatio = 1;

  // --- loop state -----------------------------------------------------------------------------
  let raf = 0;
  let lastTime = 0;
  let gain = 0;
  let easing = false;
  let spawnDirty = true;
  let staticDirty = true;
  let cleared = true;
  let reduced = false;
  let frames = 0;
  let frameCostMs = 0;
  let costSamples = 0;
  let smoothedCost = 0;

  // --- canvas ---------------------------------------------------------------------------------
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  let compositor: Compositor | null = null;

  function viewportSize(): { width: number; height: number } {
    const el = map.getCanvas?.();
    const width = el?.clientWidth || 1024;
    const height = el?.clientHeight || 640;
    return { width, height };
  }

  // ===========================================================================================
  // Colour tables
  // ===========================================================================================

  let windStroke: string[][] = [];
  let rainStroke: string[][] = [];
  let snowSprites: HTMLCanvasElement[] = [];
  let splashStroke: string[] = [];

  function buildStyles(): void {
    const tune = TUNE[theme];
    const share = subtle ? RISK_WIND_SHARE : 1;
    windStroke = [];
    const tmp: [number, number, number] = [0, 0, 0];
    for (let b = 0; b < SPEED_BUCKETS; b += 1) {
      const mph = speedBucketMph(b);
      const rgb = tinted(rampRgb("wind", mph, tmp), tune);
      const a = windAlpha(mph) * tune.alpha * share;
      windStroke.push(TIER_ALPHA.map((tier) => rgba(rgb, a * tier)));
    }
    rainStroke = [];
    snowSprites = [];
    for (let b = 0; b < PRECIP_BUCKETS; b += 1) {
      const rgb = tinted(rampRgb("rain", precipBucketValue("rain", b), tmp), tune);
      const a = (0.42 + 0.12 * b) * tune.alpha;
      rainStroke.push([rgba(rgb, a * 0.38), rgba(rgb, a)]);
      const snowRgb = snowTint(b, tune);
      snowSprites.push(makeFlakeSprite(snowRgb));
    }
    splashStroke = [0, 1, 2].map((t) => rgba(tinted(rampRgb("rain", 0.1, tmp), tune), (0.36 - t * 0.11) * tune.alpha));
  }

  function snowTint(bucket: number, tune: ThemeTune): [number, number, number] {
    const rgb = rampRgb("snow", precipBucketValue("snow", bucket) * 1.4);
    if (theme === "light") {
      // Pale flakes vanish on a light basemap: pull them to a cool slate-blue.
      const base: [number, number, number] = [rgb[0] * 0.5 + 60 * 0.5, rgb[1] * 0.5 + 100 * 0.5, rgb[2] * 0.5 + 170 * 0.5];
      return tinted(base, { ...tune, mixBlack: 0.1 });
    }
    return tinted(rgb, { ...tune, mixWhite: 0.55 });
  }

  function makeFlakeSprite(rgb: readonly number[]): HTMLCanvasElement {
    const size = 24;
    const sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const g = sprite.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, rgba(rgb, 1));
      grad.addColorStop(0.35, rgba(rgb, 0.85));
      grad.addColorStop(1, rgba(rgb, 0));
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    }
    return sprite;
  }

  // ===========================================================================================
  // Canvas sizing and compositors
  // ===========================================================================================

  function resizeCanvas(): boolean {
    const el = map.getCanvas();
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    let ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (w * h * ratio * ratio > MAX_CANVAS_PIXELS) ratio = Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    const pw = Math.max(1, Math.round(w * ratio));
    const ph = Math.max(1, Math.round(h * ratio));
    if (canvas.width === pw && canvas.height === ph && cssW === w && cssH === h) return false;
    canvas.width = pw;
    canvas.height = ph;
    cssW = w;
    cssH = h;
    pixelRatio = ratio;
    cleared = false;
    staticDirty = true;
    return true;
  }

  function createOverlayCompositor(): Compositor {
    const container = map.getCanvasContainer();
    canvas.setAttribute("aria-hidden", "true");
    canvas.dataset.weatherAnimation = "overlay";
    Object.assign(canvas.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      opacity: "0",
    });
    const mapCanvas = map.getCanvas();
    if (mapCanvas.parentNode === container) container.insertBefore(canvas, mapCanvas.nextSibling);
    else container.appendChild(canvas);
    return {
      markDirty: () => undefined,
      setOpacity: (opacity) => {
        canvas.style.opacity = opacity.toFixed(3);
      },
      detach: () => canvas.remove(),
    };
  }

  const VERTEX = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
  const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv) * u_opacity;
}`;

  let layerOpacity = 0;
  let textureDirty = true;
  let layerAttached = false;
  let layerFailed = false;

  function createLayerCompositor(): Compositor {
    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let buffer: WebGLBuffer | null = null;
    let texture: WebGLTexture | null = null;
    let opacityLocation: WebGLUniformLocation | null = null;
    let textureWidth = 0;
    let textureHeight = 0;

    function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("weather layer: createShader failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`weather layer shader: ${log}`);
      }
      return shader;
    }

    const layer: CustomLayerInterface = {
      id: WEATHER_LAYER_ID,
      type: "custom",
      renderingMode: "2d",
      onAdd(_map, glContext) {
        const gl = glContext as WebGL2RenderingContext;
        try {
          const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
          const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
          program = gl.createProgram();
          if (!program) throw new Error("weather layer: createProgram failed");
          gl.attachShader(program, vs);
          gl.attachShader(program, fs);
          gl.bindAttribLocation(program, 0, "a_pos");
          gl.linkProgram(program);
          gl.deleteShader(vs);
          gl.deleteShader(fs);
          if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`weather layer link: ${gl.getProgramInfoLog(program)}`);
          opacityLocation = gl.getUniformLocation(program, "u_opacity");
          vao = gl.createVertexArray();
          buffer = gl.createBuffer();
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          gl.bindVertexArray(null);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          texture = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.bindTexture(gl.TEXTURE_2D, null);
          textureWidth = 0;
          textureHeight = 0;
          textureDirty = true;
        } catch (error) {
          console.warn("Weather animation: the GL layer is unavailable, using a canvas overlay.", error);
          layerFailed = true;
        }
      },
      render(glContext) {
        const gl = glContext as WebGL2RenderingContext;
        frame(clock());
        if (!program || !texture || !vao || layerOpacity <= 0.003 || cleared) return;
        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (textureDirty) {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
          if (textureWidth !== canvas.width || textureHeight !== canvas.height) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
            textureWidth = canvas.width;
            textureHeight = canvas.height;
          } else {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
          }
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          textureDirty = false;
        }
        gl.uniform1i(gl.getUniformLocation(program, "u_tex"), 0);
        gl.uniform1f(opacityLocation, layerOpacity);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      onRemove(_map, glContext) {
        const gl = glContext as WebGL2RenderingContext;
        if (program) gl.deleteProgram(program);
        if (vao) gl.deleteVertexArray(vao);
        if (buffer) gl.deleteBuffer(buffer);
        if (texture) gl.deleteTexture(texture);
        program = null;
        vao = null;
        buffer = null;
        texture = null;
      },
    };

    function beforeId(): string | undefined {
      const wanted = typeof options.beforeId === "function" ? options.beforeId() : options.beforeId;
      return wanted && map.getLayer(wanted) ? wanted : undefined;
    }

    function attach(): void {
      if (layerAttached && map.getLayer(WEATHER_LAYER_ID)) return;
      try {
        map.addLayer(layer, beforeId());
        layerAttached = true;
      } catch {
        // Style not loaded yet; `style.load` retries.
        layerAttached = false;
      }
    }

    compositorHooks.attach = attach;
    compositorHooks.restack = () => {
      if (!map.getLayer(WEATHER_LAYER_ID)) {
        attach();
        return;
      }
      map.moveLayer(WEATHER_LAYER_ID, beforeId());
    };
    attach();

    return {
      markDirty: () => {
        textureDirty = true;
      },
      setOpacity: (opacity) => {
        layerOpacity = opacity;
      },
      detach: () => {
        try {
          if (map.getLayer(WEATHER_LAYER_ID)) map.removeLayer(WEATHER_LAYER_ID);
        } catch {
          // The style is already gone (map.remove()).
        }
        layerAttached = false;
      },
    };
  }

  const compositorHooks: { attach: () => void; restack: () => void } = { attach: () => undefined, restack: () => undefined };

  // ===========================================================================================
  // Camera
  // ===========================================================================================

  const inView = (x: number, y: number): boolean => {
    if (!groundToScreen(mapping, x, y, pt, 0)) return false;
    return pt[0] > 4 && pt[1] > 4 && pt[0] < cssW - 4 && pt[1] < cssH - 4;
  };

  /** Refits the ground -> screen mapping when the camera or viewport changed. Returns true if it did. */
  function updateCamera(): boolean {
    const resized = resizeCanvas();
    const center = map.getCenter();
    const zoom = map.getZoom();
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    if (
      !resized &&
      mapping.valid &&
      camera.zoom === zoom &&
      camera.lng === center.lng &&
      camera.lat === center.lat &&
      camera.bearing === bearing &&
      camera.pitch === pitch
    ) {
      return false;
    }
    camera.w = cssW;
    camera.h = cssH;
    camera.zoom = zoom;
    camera.lng = center.lng;
    camera.lat = center.lat;
    camera.bearing = bearing;
    camera.pitch = pitch;
    mercPerPx = 1 / worldSizePx(zoom);
    pitchSquash = 1 - 0.65 * Math.sin((clamp(pitch, 0, 85) * Math.PI) / 180);

    const insetX = cssW * 0.08;
    const insetY = cssH * 0.08;
    screenPoints[0] = insetX; screenPoints[1] = insetY;
    screenPoints[2] = cssW - insetX; screenPoints[3] = insetY;
    screenPoints[4] = cssW - insetX; screenPoints[5] = cssH - insetY;
    screenPoints[6] = insetX; screenPoints[7] = cssH - insetY;
    for (let k = 0; k < 4; k += 1) {
      const ll = map.unproject([screenPoints[k * 2], screenPoints[k * 2 + 1]]);
      groundPoints[k * 2] = lonToMercX(ll.lng);
      groundPoints[k * 2 + 1] = latToMercY(ll.lat);
    }
    let ok = fitScreenMapping(mapping, screenPoints, groundPoints, worldSizePx(zoom));
    if (ok) {
      // A flat Mercator ground is exactly projective; globe or terrain are not. Verify on a fifth point.
      const probe = map.unproject([cssW * 0.37, cssH * 0.66]);
      if (groundToScreen(mapping, lonToMercX(probe.lng), latToMercY(probe.lat), pt, 0)) {
        ok = Math.hypot(pt[0] - cssW * 0.37, pt[1] - cssH * 0.66) < 2.5;
      } else ok = false;
      mapping.valid = ok;
    }
    refreshVisible();
    spawnDirty = true;
    staticDirty = true;
    return true;
  }

  /** Grid slots whose cell overlaps the viewport, with the on-screen area of each. */
  function refreshVisible(): void {
    visCount = 0;
    if (!grid || !mapping.valid) return;
    const dx = grid.cellDeg / 360;
    const margin = CULL_MARGIN_PX;
    const viewArea = cssW * cssH;
    for (let c = 0; c < grid.cellCount; c += 1) {
      const x = cellX[c];
      const y = cellY[c];
      const hy = cellDy[c] / 2;
      const hx = dx / 2;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const corners = [
        [x - hx, y - hy],
        [x + hx, y - hy],
        [x + hx, y + hy],
        [x - hx, y + hy],
      ];
      let valid = true;
      let area2 = 0;
      let px0 = 0;
      let py0 = 0;
      let pxPrev = 0;
      let pyPrev = 0;
      for (let k = 0; k < 4; k += 1) {
        if (!groundToScreen(mapping, corners[k][0], corners[k][1], pt, 0)) {
          valid = false;
          break;
        }
        const sx = pt[0];
        const sy = pt[1];
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
        if (k === 0) {
          px0 = sx;
          py0 = sy;
        } else {
          area2 += pxPrev * sy - sx * pyPrev;
        }
        pxPrev = sx;
        pyPrev = sy;
      }
      if (!valid) continue;
      area2 += pxPrev * py0 - px0 * pyPrev;
      if (maxX < -margin || maxY < -margin || minX > cssW + margin || minY > cssH + margin) continue;
      const boxArea = Math.max(1, (maxX - minX) * (maxY - minY));
      const overlapW = Math.min(maxX, cssW) - Math.max(minX, 0);
      const overlapH = Math.min(maxY, cssH) - Math.max(minY, 0);
      const fraction = clamp((Math.max(0, overlapW) * Math.max(0, overlapH)) / boxArea, 0.02, 1);
      const area = Math.min(Math.abs(area2) / 2 * fraction, viewArea);
      visSlots[visCount] = grid.slotOfCell[c];
      visArea[visCount] = area;
      visCount += 1;
    }
  }

  function refreshSpawn(): void {
    spawnDirty = false;
    if (!field || !grid) return;
    const total = fillSpawnTable(table, field, kind, visSlots, visArea, visCount);
    const perParticle = kind === "wind" ? WIND_PX_PER_PARTICLE : kind === "rain" ? RAIN_PX_PER_PARTICLE : SNOW_PX_PER_PARTICLE;
    const share = kind === "wind" && subtle ? RISK_WIND_SHARE : 1;
    const set = kind === "wind" ? windSet : precipSet;
    activeCount = Math.min(set.capacity, Math.ceil((total / perParticle) * share * budgetScale));
  }

  // ===========================================================================================
  // Simulation + drawing
  // ===========================================================================================

  function clearCanvas(): void {
    if (!ctx || cleared) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    cleared = true;
    compositor?.markDirty();
  }

  function beginDraw(): void {
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.globalCompositeOperation = TUNE[theme].composite;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    cleared = false;
  }

  function endDraw(): void {
    if (!ctx) return;
    ctx.globalCompositeOperation = "source-over";
    compositor?.markDirty();
  }

  function addSplash(x: number, y: number, level: number): void {
    if (rng() > 0.45) return;
    splashX[splashCursor] = x;
    splashY[splashCursor] = y;
    splashAge[splashCursor] = 0;
    splashLevel[splashCursor] = level;
    splashCursor = (splashCursor + 1) % SPLASH_CAPACITY;
  }

  function stepSimulation(dt: number): void {
    if (!field || !grid) return;
    const env = { field, table, mercPerPx, rng, accept: inView };
    if (kind === "wind") {
      aliveCount = stepWindParticles(windSet, activeCount, dt, env);
    } else {
      aliveCount = stepPrecipParticles(
        precipSet,
        activeCount,
        dt,
        { ...env, kind: kind as PrecipKind, fallHeightPx: kind === "rain" ? RAIN_FALL_HEIGHT_PX : SNOW_FALL_HEIGHT_PX },
        kind === "rain" ? addSplash : undefined,
      );
      for (let s = 0; s < SPLASH_CAPACITY; s += 1) {
        if (splashAge[s] < SPLASH_SECONDS) splashAge[s] += dt;
      }
    }
  }

  /** Counting sort of draw candidates by bucket into `order`; fills `bucketStart`. */
  function sortByBucket(count: number, buckets: number): void {
    bucketStart.fill(0, 0, buckets + 1);
    for (let n = 0; n < count; n += 1) bucketStart[drawBucket[n] + 1] += 1;
    for (let b = 0; b < buckets; b += 1) bucketStart[b + 1] += bucketStart[b];
    // Use a moving cursor copy stored after the table: reuse `order` positions via a temp offset array.
    for (let n = 0; n < count; n += 1) {
      const b = drawBucket[n];
      order[bucketStart[b]] = drawIdx[n];
      bucketStart[b] += 1;
    }
    // Shift back so bucketStart[b] is the start again.
    for (let b = buckets; b > 0; b -= 1) bucketStart[b] = bucketStart[b - 1];
    bucketStart[0] = 0;
  }

  function drawWind(): void {
    if (!ctx) return;
    const set = windSet;
    const len = set.histLen;
    const stride = (len + 1) * 2;
    let count = 0;
    const limit = Math.min(set.capacity, activeCount + 64);
    for (let i = 0; i < limit; i += 1) {
      if (set.state[i] === STATE_IDLE) continue;
      if (!groundToScreen(mapping, set.x[i], set.y[i], pt, 0)) {
        set.state[i] = STATE_IDLE;
        continue;
      }
      const hx = pt[0];
      const hy = pt[1];
      if (hx < -CULL_MARGIN_PX || hy < -CULL_MARGIN_PX || hx > cssW + CULL_MARGIN_PX || hy > cssH + CULL_MARGIN_PX) {
        set.state[i] = STATE_IDLE;
        set.histN[i] = 0;
        continue;
      }
      const base = i * stride;
      scratch[base] = hx;
      scratch[base + 1] = hy;
      let points = 1;
      const n = set.histN[i];
      const head = set.histHead[i];
      for (let k = 1; k <= n; k += 1) {
        const idx = ((head - k + len) % len) * 2 + i * len * 2;
        if (!groundToScreen(mapping, set.hist[idx], set.hist[idx + 1], pt, 0)) break;
        scratch[base + points * 2] = pt[0];
        scratch[base + points * 2 + 1] = pt[1];
        points += 1;
      }
      if (points < 2) continue;
      scratchN[i] = points;
      drawIdx[count] = i;
      drawBucket[count] = speedBucket(set.level[i]);
      count += 1;
    }
    if (count === 0) return;
    sortByBucket(count, SPEED_BUCKETS);
    const tune = TUNE[theme];
    for (let b = 0; b < SPEED_BUCKETS; b += 1) {
      const from = bucketStart[b];
      const to = bucketStart[b + 1];
      if (to === from) continue;
      for (let tier = 0; tier < TRAIL_TIERS; tier += 1) {
        ctx.beginPath();
        let any = false;
        for (let n = from; n < to; n += 1) {
          const i = order[n];
          const segments = scratchN[i] - 1;
          let a: number;
          let z: number;
          if (segments < 3) {
            if (tier > 0) continue;
            a = 0;
            z = segments;
          } else {
            const s1 = Math.max(1, Math.round(segments / 3));
            const s2 = Math.max(s1 + 1, Math.round((segments * 2) / 3));
            a = tier === 0 ? 0 : tier === 1 ? s1 : s2;
            z = tier === 0 ? s1 : tier === 1 ? s2 : segments;
          }
          const base = i * stride;
          ctx.moveTo(scratch[base + a * 2], scratch[base + a * 2 + 1]);
          for (let k = a + 1; k <= z; k += 1) ctx.lineTo(scratch[base + k * 2], scratch[base + k * 2 + 1]);
          any = true;
        }
        if (!any) continue;
        ctx.strokeStyle = windStroke[b][tier];
        ctx.lineWidth = TIER_WIDTH[tier] * tune.width;
        ctx.stroke();
      }
    }
  }

  function drawRain(): void {
    if (!ctx) return;
    const set = precipSet;
    let count = 0;
    const limit = Math.min(set.capacity, activeCount + 64);
    for (let i = 0; i < limit; i += 1) {
      if (set.state[i] !== STATE_ALIVE) continue;
      if (!groundToScreen(mapping, set.x[i], set.y[i], pt, 0)) continue;
      const gx = pt[0];
      const gy = pt[1];
      if (gx < -CULL_MARGIN_PX || gx > cssW + CULL_MARGIN_PX || gy < -CULL_MARGIN_PX || gy > cssH + RAIN_FALL_HEIGHT_PX + CULL_MARGIN_PX) {
        set.state[i] = STATE_IDLE;
        continue;
      }
      const h = set.h[i];
      const length = rainStreakPx(set.level[i]);
      const slant = set.slant[i];
      const base = i * 6;
      // head (lowest point), middle, tail
      scratch[base] = gx - slant * h;
      scratch[base + 1] = gy - h;
      scratch[base + 2] = gx - slant * (h + length * 0.5);
      scratch[base + 3] = gy - (h + length * 0.5);
      scratch[base + 4] = gx - slant * (h + length);
      scratch[base + 5] = gy - (h + length);
      drawIdx[count] = i;
      drawBucket[count] = precipBucket(set.level[i]);
      count += 1;
    }
    if (count > 0) {
      sortByBucket(count, PRECIP_BUCKETS);
      const tune = TUNE[theme];
      for (let b = 0; b < PRECIP_BUCKETS; b += 1) {
        const from = bucketStart[b];
        const to = bucketStart[b + 1];
        if (to === from) continue;
        ctx.lineWidth = (1 + 0.18 * b) * tune.width;
        // Tail half first (dimmer), then the head half.
        for (let half = 0; half < 2; half += 1) {
          ctx.beginPath();
          for (let n = from; n < to; n += 1) {
            const base = order[n] * 6;
            if (half === 0) {
              ctx.moveTo(scratch[base + 2], scratch[base + 3]);
              ctx.lineTo(scratch[base + 4], scratch[base + 5]);
            } else {
              ctx.moveTo(scratch[base], scratch[base + 1]);
              ctx.lineTo(scratch[base + 2], scratch[base + 3]);
            }
          }
          ctx.strokeStyle = rainStroke[b][half];
          ctx.stroke();
        }
      }
    }
    drawSplashes();
  }

  function drawSplashes(): void {
    if (!ctx) return;
    for (let tier = 0; tier < 3; tier += 1) {
      ctx.beginPath();
      let any = false;
      for (let s = 0; s < SPLASH_CAPACITY; s += 1) {
        const age = splashAge[s];
        if (age >= SPLASH_SECONDS) continue;
        const t = age / SPLASH_SECONDS;
        if (Math.min(2, Math.floor(t * 3)) !== tier) continue;
        if (!groundToScreen(mapping, splashX[s], splashY[s], pt, 0)) continue;
        const rx = 0.8 + t * (2.4 + 2.6 * splashLevel[s]);
        ctx.moveTo(pt[0] + rx, pt[1]);
        ctx.ellipse(pt[0], pt[1], rx, Math.max(0.5, rx * pitchSquash), 0, 0, Math.PI * 2);
        any = true;
      }
      if (any) {
        ctx.strokeStyle = splashStroke[tier];
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }

  function drawSnow(): void {
    if (!ctx) return;
    const set = precipSet;
    const tune = TUNE[theme];
    void tune;
    const limit = Math.min(set.capacity, activeCount + 64);
    for (let i = 0; i < limit; i += 1) {
      if (set.state[i] !== STATE_ALIVE) continue;
      if (!groundToScreen(mapping, set.x[i], set.y[i], pt, 0)) continue;
      const gx = pt[0];
      const gy = pt[1];
      if (gx < -CULL_MARGIN_PX || gx > cssW + CULL_MARGIN_PX || gy < -CULL_MARGIN_PX || gy > cssH + SNOW_FALL_HEIGHT_PX + CULL_MARGIN_PX) {
        set.state[i] = STATE_IDLE;
        continue;
      }
      const h = set.h[i];
      const seed = set.seed[i];
      const intensity = set.level[i];
      // Gentle lateral sway on top of the wind drift.
      const sway = Math.sin(set.age[i] * (1.1 + 0.9 * seed) + seed * 40) * (4 + 7 * seed);
      const x = gx + sway;
      const y = gy - h;
      const fade = smoothstep(0, 16, h) * smoothstep(0, 14, SNOW_FALL_HEIGHT_PX - h);
      if (fade <= 0.01) continue;
      const radius = (1.1 + 2.1 * seed * seed + 0.9 * intensity) * (theme === "light" ? 1.1 : 1);
      ctx.globalAlpha = fade * (0.55 + 0.4 * intensity);
      const sprite = snowSprites[precipBucket(intensity)];
      ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalAlpha = 1;
  }

  // --- static (reduced motion) frame -----------------------------------------------------------

  const windTmp: WindSample = { u: 0, v: 0, speed: 0 };
  const precipTmp: PrecipSample = { rain: 0, snow: 0 };
  const dirTmp = { u: 0, v: 0 };
  const tailPt = new Float64Array(2);

  function drawStatic(): void {
    staticDirty = false;
    if (!ctx || !field || !grid || !mapping.valid) {
      clearCanvas();
      return;
    }
    beginDraw();
    const world = worldSizePx(camera.zoom);
    let m = Math.ceil(Math.log2(world / 68));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < 4; k += 1) {
      minX = Math.min(minX, groundPoints[k * 2]);
      maxX = Math.max(maxX, groundPoints[k * 2]);
      minY = Math.min(minY, groundPoints[k * 2 + 1]);
      maxY = Math.max(maxY, groundPoints[k * 2 + 1]);
    }
    const padX = (maxX - minX) * 0.1;
    const padY = (maxY - minY) * 0.1;
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    let step = 2 ** -m;
    while (((maxX - minX) / step) * ((maxY - minY) / step) > 5000 && m > 0) {
      m -= 1;
      step = 2 ** -m;
    }
    const ix0 = Math.floor(minX / step);
    const ix1 = Math.ceil(maxX / step);
    const iy0 = Math.floor(minY / step);
    const iy1 = Math.ceil(maxY / step);
    const tune = TUNE[theme];
    const stepPx = step * world;
    const share = kind === "wind" && subtle ? RISK_WIND_SHARE : 1;

    for (let iy = iy0; iy <= iy1; iy += 1) {
      for (let ix = ix0; ix <= ix1; ix += 1) {
        const jx = (ix + 0.2 + 0.6 * hash2(ix, iy, 1)) * step;
        const jy = (iy + 0.2 + 0.6 * hash2(ix, iy, 2)) * step;
        if (!inView(jx, jy)) continue;
        const sx = pt[0];
        const sy = pt[1];
        const lon = mercXToLon(jx);
        const lat = mercYToLat(jy);
        if (kind === "wind") {
          if (!sampleWind(field, lon, lat, windTmp)) continue;
          if (hash2(ix, iy, 3) > windDensity(windTmp.speed) * 0.85 + 0.12) continue;
          const mag = Math.hypot(windTmp.u, windTmp.v);
          if (mag < 1e-4) continue;
          const lengthPx = clamp(7 + 0.42 * windTmp.speed, 7, 26) * Math.min(1, stepPx / 44);
          dirTmp.u = windTmp.u / mag;
          dirTmp.v = windTmp.v / mag;
          const tx = jx + dirTmp.u * lengthPx * mercPerPx;
          const ty = jy - dirTmp.v * lengthPx * mercPerPx;
          if (!groundToScreen(mapping, tx, ty, tailPt, 0)) continue;
          const bucket = speedBucket(windTmp.speed);
          const ax = tailPt[0];
          const ay = tailPt[1];
          const vx = ax - sx;
          const vy = ay - sy;
          const vl = Math.hypot(vx, vy) || 1;
          const nx = vx / vl;
          const ny = vy / vl;
          const barb = 3.4;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ax, ay);
          ctx.moveTo(ax - nx * barb - ny * barb * 0.8, ay - ny * barb + nx * barb * 0.8);
          ctx.lineTo(ax, ay);
          ctx.lineTo(ax - nx * barb + ny * barb * 0.8, ay - ny * barb - nx * barb * 0.8);
          ctx.strokeStyle = windStroke[bucket][0];
          ctx.lineWidth = 1.5 * tune.width;
          ctx.stroke();
        } else {
          if (!samplePrecip(field, lon, lat, precipTmp)) continue;
          const value = kind === "rain" ? precipTmp.rain : precipTmp.snow;
          const intensity = precipIntensity(kind, value);
          if (intensity <= 0 || hash2(ix, iy, 4) > intensity * 0.9 + 0.06) continue;
          const b = precipBucket(intensity);
          if (kind === "rain") {
            const length = rainStreakPx(intensity) * 0.7;
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx - length * 0.16, sy - length);
            ctx.strokeStyle = rainStroke[b][1];
            ctx.lineWidth = (1 + 0.18 * b) * tune.width;
            ctx.stroke();
          } else {
            const radius = 1.4 + 1.8 * hash2(ix, iy, 5) + 0.8 * intensity;
            ctx.globalAlpha = 0.5 + 0.4 * intensity;
            ctx.drawImage(snowSprites[b], sx - radius, sy - radius, radius * 2, radius * 2);
            ctx.globalAlpha = 1;
          }
        }
        void share;
      }
    }
    endDraw();
  }

  // ===========================================================================================
  // Frame
  // ===========================================================================================

  function isActive(): boolean {
    return data !== null && grid !== null && field !== null && wantVisible;
  }

  function frame(now: number): void {
    if (destroyed) return;
    const started = clock();
    const dt = lastTime === 0 ? 1 / 60 : clamp((now - lastTime) / 1000, 0, 0.05);
    lastTime = now;
    reduced = options.reducedMotion();
    const active = isActive();

    // Fade in/out
    const goal = active ? 1 : 0;
    if (reduced) gain = goal;
    else if (gain < goal) gain = Math.min(goal, gain + dt / FADE_SECONDS);
    else if (gain > goal) gain = Math.max(goal, gain - dt / FADE_SECONDS);
    applyOpacity();

    if (!field || !grid || (!active && gain <= 0.003)) {
      if (!active && gain <= 0.003) clearCanvas();
      return;
    }

    const cameraChanged = updateCamera();
    if (!mapping.valid) {
      clearCanvas();
      return;
    }
    if (easing && target) {
      easing = easeField(field, target, reduced ? 1 : 1 - Math.exp(-dt / (FIELD_EASE_SECONDS / 3)));
      spawnDirty = true;
      staticDirty = true;
    }
    if (spawnDirty || cameraChanged) refreshSpawn();

    if (reduced) {
      if (staticDirty || cameraChanged) drawStatic();
    } else {
      stepSimulation(dt);
      beginDraw();
      if (kind === "wind") drawWind();
      else if (kind === "rain") drawRain();
      else drawSnow();
      endDraw();
    }
    frames += 1;
    if (!reduced) adapt(clock() - started);
  }

  function adapt(cost: number): void {
    smoothedCost = smoothedCost === 0 ? cost : smoothedCost * 0.9 + cost * 0.1;
    frameCostMs += cost;
    costSamples += 1;
    if (!adaptive || costSamples < 45) {
      if (!adaptive) {
        frameCostMs = 0;
        costSamples = 0;
      }
      return;
    }
    const average = frameCostMs / costSamples;
    frameCostMs = 0;
    costSamples = 0;
    if (average > 9 && budgetScale > 0.35) {
      budgetScale = Math.max(0.35, budgetScale * 0.82);
      spawnDirty = true;
    } else if (average < 4 && budgetScale < 1) {
      budgetScale = Math.min(1, budgetScale * 1.08);
      spawnDirty = true;
    }
  }

  let lastOpacity = -1;
  function applyOpacity(): void {
    const opacity = clamp(gain, 0, 1);
    if (Math.abs(opacity - lastOpacity) < 0.002) return;
    lastOpacity = opacity;
    compositor?.setOpacity(opacity);
  }

  // ===========================================================================================
  // Scheduling
  // ===========================================================================================

  function shouldRun(): boolean {
    if (destroyed || document.hidden || options.reducedMotion()) return false;
    return isActive() || gain > 0.003;
  }

  function tick(time: number): void {
    raf = 0;
    if (!shouldRun()) {
      if (!isActive() && !document.hidden) {
        // Fully faded out: draw the cleared state once and stop.
        gain = 0;
        applyOpacity();
        clearCanvas();
        if (mode === "layer") map.triggerRepaint();
      }
      return;
    }
    if (mode === "layer" && !layerFailed) map.triggerRepaint();
    else frame(time);
    raf = requestFrame(tick);
  }

  function startLoop(): void {
    if (raf !== 0 || !shouldRun()) return;
    lastTime = 0;
    raf = requestFrame(tick);
  }

  function stopLoop(): void {
    if (raf !== 0) {
      cancelFrame(raf);
      raf = 0;
    }
  }

  /** Re-evaluates what should run after any state change. */
  function evaluate(): void {
    if (destroyed) return;
    reduced = options.reducedMotion();
    if (reduced || document.hidden) {
      stopLoop();
      if (reduced) {
        staticDirty = true;
        paintOnce();
      }
      return;
    }
    if (shouldRun()) startLoop();
    else {
      stopLoop();
      if (gain > 0) paintOnce();
    }
  }

  /** One synchronous redraw (overlay) or repaint request (layer). */
  function paintOnce(): void {
    if (mode === "layer" && !layerFailed) map.triggerRepaint();
    else frame(clock());
  }

  // ===========================================================================================
  // Events
  // ===========================================================================================

  const onRender = (): void => {
    if (destroyed || raf !== 0) return;
    // Camera moved while idle (reduced motion / static): keep the still frame glued to the map.
    if (mode === "overlay" || layerFailed) frame(clock());
  };
  const onResize = (): void => {
    staticDirty = true;
    spawnDirty = true;
    evaluate();
  };
  const onVisibility = (): void => {
    lastTime = 0;
    evaluate();
  };
  const onStyleLoad = (): void => {
    if (mode === "layer") {
      layerAttached = false;
      compositorHooks.attach();
    }
  };
  const motionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  const onMotionChange = (): void => evaluate();

  map.on("resize", onResize);
  map.on("style.load", onStyleLoad);
  if (mode === "overlay") map.on("render", onRender);
  document.addEventListener("visibilitychange", onVisibility);
  motionQuery?.addEventListener?.("change", onMotionChange);

  if (mode === "overlay") compositor = createOverlayCompositor();
  else {
    compositor = createLayerCompositor();
  }
  resizeCanvas();
  buildStyles();

  // ===========================================================================================
  // Public API
  // ===========================================================================================

  function fillTarget(): void {
    if (data && target) fillField(target, data, hour);
  }

  const api: WeatherAnimation = {
    setData(heat) {
      if (destroyed) return;
      data = heat;
      grid = heat ? buildGrid(heat.cells, heat.cell_deg) : null;
      resetParticles(windSet);
      resetParticles(precipSet);
      splashAge.fill(SPLASH_SECONDS);
      visCount = 0;
      mapping.valid = false;
      camera.zoom = NaN;
      if (!heat || !grid) {
        field = null;
        target = null;
        clearCanvas();
        evaluate();
        return;
      }
      field = createField(grid);
      target = createField(grid);
      cellX = new Float64Array(grid.cellCount);
      cellY = new Float64Array(grid.cellCount);
      cellDy = new Float64Array(grid.cellCount);
      const half = grid.cellDeg / 2;
      for (let c = 0; c < grid.cellCount; c += 1) {
        const slot = grid.slotOfCell[c];
        const lon = slotLon(grid, slot);
        const lat = slotLat(grid, slot);
        cellX[c] = lonToMercX(lon);
        cellY[c] = latToMercY(lat);
        cellDy[c] = Math.abs(latToMercY(lat - half) - latToMercY(lat + half));
      }
      visSlots = new Int32Array(grid.cellCount);
      visArea = new Float32Array(grid.cellCount);
      table = createSpawnTable(grid.cellCount);
      fillTarget();
      copyField(field, target);
      easing = false;
      spawnDirty = true;
      staticDirty = true;
      evaluate();
      paintOnce();
    },

    setFrame(nextHour, nextVariable, visible) {
      if (destroyed) return;
      const nextKind = kindOf(nextVariable);
      const hourChanged = Math.abs(nextHour - hour) > 1e-4;
      hour = Number.isFinite(nextHour) ? nextHour : 0;
      const kindChanged = nextKind !== kind;
      variable = nextVariable;
      const nextSubtle = nextVariable === "risk";
      const styleChanged = nextSubtle !== subtle;
      subtle = nextSubtle;
      wantVisible = visible;
      if (kindChanged) {
        kind = nextKind;
        resetParticles(windSet);
        resetParticles(precipSet);
        splashAge.fill(SPLASH_SECONDS);
        activeCount = 0;
        if (gain > 0) gain = 0;
        lastOpacity = -1;
        spawnDirty = true;
      }
      if (styleChanged || kindChanged) buildStyles();
      if (data && target && (hourChanged || kindChanged)) {
        fillTarget();
        easing = true;
      }
      spawnDirty = true;
      staticDirty = true;
      evaluate();
    },

    setTheme(nextTheme) {
      if (destroyed || nextTheme === theme) return;
      theme = nextTheme;
      buildStyles();
      staticDirty = true;
      evaluate();
      if (gain > 0) paintOnce();
    },

    restack() {
      if (!destroyed && mode === "layer") compositorHooks.restack();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      map.off("resize", onResize);
      map.off("style.load", onStyleLoad);
      if (mode === "overlay") map.off("render", onRender);
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery?.removeEventListener?.("change", onMotionChange);
      compositor?.detach();
      compositor = null;
      data = null;
      grid = null;
      field = null;
      target = null;
      canvas.width = 0;
      canvas.height = 0;
    },

    debug() {
      return {
        mode: mode === "layer" && layerFailed ? "overlay" : mode,
        kind,
        capacity: kind === "wind" ? windSet.capacity : precipSet.capacity,
        activeParticles: activeCount,
        aliveParticles: aliveCount,
        gain,
        budgetScale,
        running: raf !== 0,
        reduced,
        attached: mode === "layer" ? layerAttached : canvas.isConnected,
        buffers: { fieldU: field?.u ?? null, windX: windSet.x, precipX: precipSet.x, table: table.slots, scratch },
        mappingValid: mapping.valid,
        frames,
        frameMs: smoothedCost,
        realDirections: field?.realDirections ?? 0,
      };
    },
  };

  // `variable` is read by integrations through debug tooling only.
  void variable;
  void windVector;
  void visualSpeedPx;
  return api;
}
