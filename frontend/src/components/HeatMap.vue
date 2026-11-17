<template>
  <div class="heatmap">
    <div class="hm-title" v-if="title">
      <span>{{ title }}</span>
      <span class="muted small hover">{{ hoverText }}</span>
    </div>
    <div class="hm-row">
      <div
        ref="box"
        class="hm-box"
        :style="{ aspectRatio: String(aspect) }"
        @mousemove="onMove"
        @mouseleave="hoverText = ''"
        @mousedown="onDown"
        :class="{ 'region-tool': !!regionTool }"
        @dblclick="onDouble"
      >
        <canvas ref="canvas" class="hm-canvas" :class="{ crisp }" />
        <svg v-if="axes" class="hm-axes" viewBox="0 0 44 44" aria-hidden="true">
          <title>The red and green arrows are drawn at the same corner of the exit surface in the 3D view</title>
          <g stroke-linecap="round" stroke-linejoin="round" fill="none">
            <path d="M6 38 H34 M29 33 L34 38 L29 43" class="ax-halo" />
            <path d="M6 38 V10 M1 15 L6 10 L11 15" class="ax-halo" />
            <path d="M6 38 H34 M29 33 L34 38 L29 43" class="ax-u" />
            <path d="M6 38 V10 M1 15 L6 10 L11 15" class="ax-v" />
          </g>
        </svg>
        <svg v-if="regionPoints || draftPoints" class="hm-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon v-if="regionPoints" :points="regionPoints" class="hm-region" />
          <polyline v-if="draftPoints" :points="draftPoints" class="hm-region draft" />
        </svg>
        <div v-for="(h, i) in hotspots" :key="i" class="hm-marker" :style="{ left: h.u * 100 + '%', top: (1 - h.v) * 100 + '%' }" :title="`Hotspot ${h.ratio.toFixed(2)}x average`">
          <span>{{ h.ratio.toFixed(1) }}×</span>
        </div>
        <div v-if="roiRect" class="hm-roi" :style="roiRect" />
        <div v-if="dragRect" class="hm-roi drag" :style="dragRect" />
      </div>
      <div v-if="!rgb" class="hm-scale">
        <span>{{ fmt(vmax) }}</span>
        <div class="hm-bar" :style="{ background: gradient }" />
        <span>{{ fmt(vmin) }}</span>
        <span class="muted small">{{ unit }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { cssGradient, fmtNum } from "../utils/colormap";
import { drawMap } from "../utils/drawMap";

const props = withDefaults(
  defineProps<{
    values: number[][];
    valid?: number[][] | null;
    vmin?: number;
    vmax: number;
    unit?: string;
    uMm?: number;
    vMm?: number;
    hotspots?: { u: number; v: number; ratio: number }[];
    roi?: number[] | null;
    title?: string;
    diverging?: boolean;
    log?: boolean;
    rgb?: number[][][] | null;
    selectable?: boolean;
    maxAspect?: number;
    /** Draw a box or a free-hand outline instead of the statistics region; `region` is reported as [[u, v], ...] (fractions, v up). */
    regionTool?: "box" | "lasso" | null;
    region?: number[][] | null;
    /** Show the u / v arrows in the corner (the same arrows are drawn on the exit surface in the 3D view). */
    axes?: boolean;
  }>(),
  { axes: true, vmin: 0, valid: null, unit: "", uMm: 1, vMm: 1, hotspots: () => [], roi: null, title: "", diverging: false, log: false, rgb: null, selectable: false, maxAspect: 14, regionTool: null, region: null },
);
const emit = defineEmits<{ roi: [roi: number[] | null]; region: [polygon: number[][] | null] }>();

const draft = ref<{ x: number; y: number }[]>([]);
const toSvg = (pts: { x: number; y: number }[]) => pts.map((p) => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(" ");
const regionPoints = computed(() => (props.region && props.region.length >= 3 ? toSvg(props.region.map((p) => ({ x: p[0], y: 1 - p[1] }))) : ""));
const draftPoints = computed(() => (draft.value.length >= 2 ? toSvg(draft.value) : ""));
function onDouble() {
  if (props.regionTool) emit("region", null);
  else emit("roi", null);
}

const canvas = ref<HTMLCanvasElement | null>(null);
const box = ref<HTMLElement | null>(null);
const hoverText = ref("");
const dragRect = ref<Record<string, string> | null>(null);
let dragStart: { x: number; y: number } | null = null;

const aspect = computed(() => Math.min(Math.max(props.uMm / Math.max(props.vMm, 1e-6), 1 / props.maxAspect), props.maxAspect));
const crisp = computed(() => (props.values[0]?.length ?? 0) < 90 && props.values.length < 90);
const gradient = computed(() => cssGradient(props.diverging ? "diverging" : "turbo"));
const fmt = (x: number) => fmtNum(x);

function draw() {
  if (canvas.value && props.values.length) drawMap(canvas.value, props.values, props.valid, props.vmin, props.vmax, { flipV: true, diverging: props.diverging, log: props.log, rgb: props.rgb });
}
onMounted(draw);
watch(() => [props.values, props.valid, props.vmin, props.vmax, props.diverging, props.log, props.rgb], draw, { deep: false });

const roiRect = computed(() => {
  const r = props.roi;
  if (!r || (r[0] <= 0 && r[1] <= 0 && r[2] >= 1 && r[3] >= 1)) return null;
  return { left: r[0] * 100 + "%", width: (r[2] - r[0]) * 100 + "%", top: (1 - r[3]) * 100 + "%", height: (r[3] - r[1]) * 100 + "%" };
});

function frac(e: MouseEvent) {
  const rect = box.value!.getBoundingClientRect();
  return { x: Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1), y: Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1) };
}
function onMove(e: MouseEvent) {
  const f = frac(e);
  const nv = props.values.length;
  const nu = props.values[0]?.length ?? 0;
  if (!nu) return;
  const ix = Math.min(Math.floor(f.x * nu), nu - 1);
  const iy = Math.min(Math.floor((1 - f.y) * nv), nv - 1);
  if (props.rgb) hoverText.value = `u ${(f.x * props.uMm).toFixed(1)} mm, v ${((1 - f.y) * props.vMm).toFixed(1)} mm`;
  else hoverText.value = `${fmtNum(props.values[iy][ix])} ${props.unit}  at u ${(f.x * props.uMm).toFixed(1)}, v ${((1 - f.y) * props.vMm).toFixed(1)} mm`;
  if (dragStart) {
    const a = dragStart;
    dragRect.value = { left: Math.min(a.x, f.x) * 100 + "%", width: Math.abs(f.x - a.x) * 100 + "%", top: Math.min(a.y, f.y) * 100 + "%", height: Math.abs(f.y - a.y) * 100 + "%" };
  }
}
/** Keep at most ~60 points of a free-hand outline. */
function thin(pts: { x: number; y: number }[]) {
  const step = Math.max(1, Math.ceil(pts.length / 60));
  return pts.filter((_, i) => i % step === 0);
}
function onRegionDown(e: MouseEvent) {
  const tool = props.regionTool;
  const a = frac(e);
  draft.value = [a];
  const move = (ev: MouseEvent) => {
    const b = frac(ev);
    if (tool === "box") draft.value = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
    else {
      const last = draft.value[draft.value.length - 1];
      if (Math.hypot(b.x - last.x, b.y - last.y) > 0.004) draft.value = [...draft.value, b];
    }
  };
  const up = (ev: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    move(ev);
    const pts = draft.value;
    draft.value = [];
    if (tool === "box") {
      const b = pts[2];
      if (!b || Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01) return;
      emit("region", [[Math.min(a.x, b.x), 1 - Math.max(a.y, b.y)], [Math.max(a.x, b.x), 1 - Math.max(a.y, b.y)], [Math.max(a.x, b.x), 1 - Math.min(a.y, b.y)], [Math.min(a.x, b.x), 1 - Math.min(a.y, b.y)]]);
    } else {
      if (pts.length < 4) return;
      let area = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        area += p.x * q.y - q.x * p.y;
      }
      if (Math.abs(area) / 2 < 0.0002) return;
      emit("region", thin(pts).map((p) => [p.x, 1 - p.y]));
    }
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
function onDown(e: MouseEvent) {
  if (props.regionTool && e.button === 0) {
    e.preventDefault();
    onRegionDown(e);
    return;
  }
  if (!props.selectable || e.button !== 0) return;
  dragStart = frac(e);
  const up = (ev: MouseEvent) => {
    window.removeEventListener("mouseup", up);
    const a = dragStart;
    dragStart = null;
    dragRect.value = null;
    if (!a) return;
    const b = frac(ev);
    if (Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01) return;
    emit("roi", [Math.min(a.x, b.x), 1 - Math.max(a.y, b.y), Math.max(a.x, b.x), 1 - Math.min(a.y, b.y)]);
  };
  window.addEventListener("mouseup", up);
}
</script>
