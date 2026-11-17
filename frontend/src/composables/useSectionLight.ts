// Light at a section plane: the flux passing through the cut (drawn on the cut) and the "ray fan" (only the rays' part
// close to the cut, which turns the tangle of rays into a readable picture).
import { computed, onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { api, type SliceResponse } from "../api";
import { turbo } from "../utils/colormap";
import type { AnalysisView } from "./useAnalysisView";

type Axis = "x" | "y" | "z";
export type SectionLightMode = "off" | "flux" | "fan";

const AXES: Record<Axis, number[]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Viewer = any;
interface OverlayLike {
  setSlice: (s: { corners: number[][]; normal: number[]; canvas: HTMLCanvasElement } | null, lift: number) => void;
}

/** Colours of the flux grid: turbo, see-through where (almost) no light passes. */
function fluxCanvas(r: SliceResponse): { canvas: HTMLCanvasElement; vmax: number } {
  const vals = r.values.flat().filter((x) => x > 0).sort((a, b) => a - b);
  const vmax = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.995))] || r.max : r.max || 1;
  const canvas = document.createElement("canvas");
  canvas.width = r.nu;
  canvas.height = r.nv;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(r.nu, r.nv);
  for (let j = 0; j < r.nv; j++) {
    for (let i = 0; i < r.nu; i++) {
      const t = Math.min(1, r.values[j][i] / vmax);
      const [R, G, B] = turbo(t);
      const o = (j * r.nu + i) * 4;
      img.data[o] = R;
      img.data[o + 1] = G;
      img.data[o + 2] = B;
      img.data[o + 3] = Math.round(255 * 0.92 * Math.min(1, t / 0.04));
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, vmax };
}

export function useSectionLight(
  runId: Ref<string | null>,
  stateId: Ref<string | undefined>,
  viewer: Viewer,
  overlay: OverlayLike,
  av: AnalysisView,
  flip: { x: boolean; y: boolean; z: boolean },
  diag: Ref<number>,
) {
  const mode = ref<SectionLightMode>("off");
  const chosen = ref<Axis | null>(null);
  const direction = ref<"both" | "along" | "against">("both");
  const outcome = ref<"" | "exit" | "absorbed" | "other">("");
  const thickness = ref(0); // mm; 0 = not set yet (a default is taken from the model size)
  const loading = ref(false);
  const error = ref("");
  const result = shallowRef<SliceResponse | null>(null);
  /** Flux (fraction of the emitted light per mm²) that the brightest colour stands for. */
  const vmax = ref(0);

  const activeAxes = computed<Axis[]>(() => (["x", "y", "z"] as Axis[]).filter((a) => viewer.activeCuttingPlanes.value.has(a)));
  /** The plane the tools use: the chosen one if it is on, else the first plane that is on. */
  const axis = computed<Axis | null>(() => (chosen.value && activeAxes.value.includes(chosen.value) ? chosen.value : (activeAxes.value[0] ?? null)));
  const distance = computed(() => (axis.value ? viewer.planeDistances[axis.value] : 0));
  /** The side of the cut that stays (the model is cut away on the other side). */
  const kept = computed<number[] | null>(() => (axis.value ? AXES[axis.value].map((c) => (flip[axis.value as Axis] ? -c : c)) : null));
  const origin = computed<number[] | null>(() => (axis.value ? AXES[axis.value].map((c) => c * distance.value) : null));
  const maxThickness = computed(() => Math.max(1, diag.value * 0.4));
  const effectiveThickness = computed(() => (thickness.value > 0 ? thickness.value : Math.max(0.1, diag.value * 0.05)));

  // ── flux through the cut ─────────────────────────────────────────────────────────
  let seq = 0;
  let timer: number | null = null;
  async function fetchSlice() {
    const rid = runId.value;
    const ax = axis.value;
    if (!rid || !ax || mode.value !== "flux") return;
    const mine = ++seq;
    loading.value = true;
    error.value = "";
    try {
      const r = await api.analysisSlice(rid, {
        origin: AXES[ax].map((c) => c * viewer.planeDistances[ax]),
        normal: AXES[ax],
        direction: direction.value,
        outcome: outcome.value,
        state: stateId.value,
      });
      if (mine !== seq || mode.value !== "flux") return;
      result.value = r;
      const { canvas, vmax: vm } = fluxCanvas(r);
      vmax.value = vm;
      const k = kept.value ?? AXES[ax];
      overlay.setSlice({ corners: r.corners, normal: k, canvas }, Math.max(diag.value * 0.0006, 0.01));
    } catch (e) {
      if (mine !== seq) return;
      error.value = (e as Error).message;
      result.value = null;
      overlay.setSlice(null, 0);
    } finally {
      if (mine === seq) loading.value = false;
    }
  }
  function clearSlice() {
    seq++;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    loading.value = false;
    result.value = null;
    overlay.setSlice(null, 0);
  }
  function scheduleSlice() {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void fetchSlice();
    }, 250);
  }

  // ── the ray fan ─────────────────────────────────────────────────────────────────
  function applyFan() {
    if (mode.value === "fan" && origin.value && kept.value) av.slab.value = { origin: origin.value, normal: kept.value, thickness: effectiveThickness.value };
    else av.slab.value = null;
  }
  /** The fan needs rays: if the Rays layer is off, switch it to the light that reaches the exit (the dock shows and changes it). */
  function ensureRays() {
    if (av.layers.rays !== "off" || !runId.value) return;
    av.form.count = 1500;
    av.layers.rays = "exit";
  }

  function setMode(m: SectionLightMode) {
    mode.value = mode.value === m ? "off" : m;
  }

  watch(mode, (m) => {
    if (m !== "flux") clearSlice();
    if (m === "flux") scheduleSlice();
    if (m === "fan") ensureRays();
    applyFan();
  });
  watch([axis, distance, () => (axis.value ? flip[axis.value] : false), direction, outcome, stateId], () => {
    if (mode.value === "flux") {
      if (axis.value) scheduleSlice();
      else clearSlice();
    }
    applyFan();
  });
  watch(effectiveThickness, applyFan);
  watch(runId, () => {
    mode.value = "off";
    clearSlice();
    av.slab.value = null;
  });

  /** Look straight onto the cut, from the side that was cut away. */
  function lookAtCut() {
    const k = kept.value;
    if (!k || !axis.value) return;
    const up = axis.value === "z" ? [0, 1, 0] : [0, 0, 1];
    const r = result.value;
    // frame the cut: the slice grid covers the whole model in the plane, so use its size when there is one
    if (r) {
      const mid = [0, 1, 2].map((i) => (r.corners[0][i] + r.corners[2][i]) / 2);
      viewer.lookAlong(k, up, { center: mid, extent: Math.max(r.uMm, r.vMm) });
    } else viewer.lookAlong(k, up);
  }

  onBeforeUnmount(() => {
    if (timer !== null) window.clearTimeout(timer);
    av.slab.value = null;
  });

  return { mode, setMode, axis, activeAxes, chosen, direction, outcome, thickness, effectiveThickness, maxThickness, loading, error, result, vmax, lookAtCut };
}

export type SectionLight = ReturnType<typeof useSectionLight>;
