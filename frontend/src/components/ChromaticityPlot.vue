<template>
  <div class="chroma">
    <div class="hm-title"><span>Colour variation (CIE 1976 u′ v′)</span></div>
    <svg :viewBox="`${x0} ${-y1} ${x1 - x0} ${y1 - y0}`" class="chroma-svg" preserveAspectRatio="xMidYMid meet">
      <polygon :points="locus" class="locus" />
      <g v-if="mean">
        <circle :cx="mean.u" :cy="-mean.v" r="0.01" class="ring" />
        <circle :cx="mean.u" :cy="-mean.v" r="0.005" class="ring" />
      </g>
      <circle v-for="(p, i) in cloud" :key="i" :cx="p[0]" :cy="-p[1]" r="0.0016" class="dot" />
      <circle v-if="mean" :cx="mean.u" :cy="-mean.v" r="0.004" class="mean" />
    </svg>
    <div class="muted small">Rings: Δu′v′ = 0.005 and 0.010 around the average colour. {{ cloud.length }} pixels shown.</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ xy: number[][][]; mask: number[][]; mean: { u: number; v: number } | null }>();

function g(l: number, mu: number, s1: number, s2: number) {
  const t = (l - mu) / (l < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cmf(l: number): [number, number, number] {
  return [
    1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2),
    0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1),
    1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8),
  ];
}
const uv = (X: number, Y: number, Z: number): [number, number] => {
  const d = X + 15 * Y + 3 * Z || 1;
  return [(4 * X) / d, (9 * Y) / d];
};

const locus = computed(() => {
  const pts: string[] = [];
  for (let l = 420; l <= 680; l += 5) {
    const [u, v] = uv(...cmf(l));
    pts.push(`${u.toFixed(4)},${(-v).toFixed(4)}`);
  }
  return pts.join(" ");
});

const cloud = computed(() => {
  const out: number[][] = [];
  const nv = props.xy.length;
  const nu = props.xy[0]?.length ?? 0;
  const stride = Math.max(1, Math.floor((nu * nv) / 700));
  let k = 0;
  for (let y = 0; y < nv; y++)
    for (let x = 0; x < nu; x++) {
      if (!props.mask[y][x] || k++ % stride) continue;
      const [cx, cy] = props.xy[y][x];
      const d = -2 * cx + 12 * cy + 3 || 1;
      out.push([(4 * cx) / d, (9 * cy) / d]);
    }
  return out;
});

// zoom on the data (but never smaller than a useful window around the white point)
const bounds = computed(() => {
  const pts = [...cloud.value, ...(props.mean ? [[props.mean.u, props.mean.v]] : [])];
  if (!pts.length) return { x0: 0.15, x1: 0.35, y0: 0.4, y1: 0.55 };
  const us = pts.map((p) => p[0]);
  const vs = pts.map((p) => p[1]);
  const cu = (Math.min(...us) + Math.max(...us)) / 2;
  const cv = (Math.min(...vs) + Math.max(...vs)) / 2;
  const half = Math.max((Math.max(...us) - Math.min(...us)) / 2, (Math.max(...vs) - Math.min(...vs)) / 2, 0.015) * 1.25;
  return { x0: cu - half, x1: cu + half, y0: cv - half, y1: cv + half };
});
const x0 = computed(() => bounds.value.x0);
const x1 = computed(() => bounds.value.x1);
const y0 = computed(() => bounds.value.y0);
const y1 = computed(() => bounds.value.y1);
</script>
