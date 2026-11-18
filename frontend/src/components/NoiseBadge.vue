<template>
  <div v-if="noise" class="noise-badge" :class="{ warn: !noise.converged }">
    <div class="noise-line">
      <AlertTriangle v-if="!noise.converged" :size="13" />
      <Check v-else :size="13" />
      <span>
        Map noise <strong>{{ pct(noise.median) }}</strong> per pixel
        <span class="muted">(worst 10 %: {{ pct(noise.p90) }}, target {{ pct(noise.target) }})</span>
      </span>
    </div>
    <p v-if="!noise.converged && noise.raysForTarget" class="muted small noise-hint">
      Too noisy to judge shading or hotspots by eye. For {{ pct(noise.target) }}: about {{ fmtRays(noise.raysForTarget) }} rays per channel
      <template v-if="noise.resolutionForTarget"> or a map resolution of {{ noise.resolutionForTarget }} px</template>.
    </p>
  </div>
</template>

<script setup lang="ts">
import { AlertTriangle, Check } from "lucide-vue-next";
import type { MapNoise } from "../api";

defineProps<{ noise?: MapNoise | null }>();

const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)} %`;
function fmtRays(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} M`;
  return `${Math.round(n / 1e3)} k`;
}
</script>

<style scoped>
.noise-badge {
  font-size: 12px;
  line-height: 1.35;
}
.noise-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.noise-badge.warn .noise-line {
  color: var(--warn, #d9822b);
}
.noise-hint {
  margin: 2px 0 0;
}
</style>
