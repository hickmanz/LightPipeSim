<template>
  <div class="linechart">
    <div v-if="title" class="hm-title"><span>{{ title }}</span></div>
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="lc-svg">
      <g class="lc-grid">
        <line v-for="t in yTicks" :key="'y' + t" :x1="L" :x2="W - R" :y1="py(t)" :y2="py(t)" />
        <line v-for="t in xTicks" :key="'x' + t" :x1="px(t)" :x2="px(t)" :y1="T" :y2="H - B" />
      </g>
      <g class="lc-axis">
        <text v-for="t in yTicks" :key="'yl' + t" :x="L - 4" :y="py(t) + 3" text-anchor="end">{{ fmtNum(t) }}</text>
        <text v-for="t in xTicks" :key="'xl' + t" :x="px(t)" :y="H - B + 12" text-anchor="middle">{{ fmtNum(t) }}</text>
        <text :x="(L + W - R) / 2" :y="H - 2" text-anchor="middle">{{ xLabel }}</text>
      </g>
      <polyline v-for="s in series" :key="s.label" :points="points(s)" :stroke="s.color" :stroke-dasharray="s.dashed ? '4 3' : ''" fill="none" stroke-width="1.6" vector-effect="non-scaling-stroke" />
    </svg>
    <div v-if="series.length > 1 || series[0]?.label" class="lc-legend">
      <span v-for="s in series" :key="s.label"><i :style="{ background: s.color }" /> {{ s.label }}</span>
      <span class="muted">{{ yLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { fmtNum } from "../utils/colormap";

export interface Series {
  label: string;
  color: string;
  x: number[];
  y: (number | null)[];
  dashed?: boolean;
}
const props = withDefaults(defineProps<{ series: Series[]; title?: string; xLabel?: string; yLabel?: string; yMin?: number | null }>(), { title: "", xLabel: "", yLabel: "", yMin: 0 });

const W = 320;
const H = 150;
const L = 40;
const R = 8;
const T = 8;
const B = 22;

const xr = computed(() => {
  const all = props.series.flatMap((s) => s.x);
  return [Math.min(...all, 0), Math.max(...all, 1e-9)] as [number, number];
});
const yr = computed(() => {
  const all = props.series.flatMap((s) => s.y.filter((v): v is number => v !== null));
  const hi = Math.max(...all, 1e-12);
  const lo = props.yMin === null ? Math.min(...all, 0) : props.yMin;
  return [lo, hi * 1.08] as [number, number];
});
const px = (x: number) => L + ((x - xr.value[0]) / (xr.value[1] - xr.value[0] || 1)) * (W - L - R);
const py = (y: number) => H - B - ((y - yr.value[0]) / (yr.value[1] - yr.value[0] || 1)) * (H - B - T);
function ticks([lo, hi]: [number, number], n = 4) {
  const step = niceStep((hi - lo) / n);
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
function niceStep(raw: number) {
  const e = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
}
const xTicks = computed(() => ticks(xr.value));
const yTicks = computed(() => ticks(yr.value));
function points(s: Series) {
  return s.x
    .map((x, i) => (s.y[i] === null ? null : `${px(x).toFixed(1)},${py(s.y[i] as number).toFixed(1)}`))
    .filter(Boolean)
    .join(" ");
}
</script>
