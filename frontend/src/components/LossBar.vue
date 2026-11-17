<template>
  <div class="lossbar">
    <div class="loss-stack">
      <div v-for="(l, i) in items" :key="i" class="loss-seg" :style="{ width: Math.max(l.fraction, 0) * 100 + '%', background: colorOf(l, i) }" :title="`${l.name}: ${(l.fraction * 100).toFixed(1)} %`" />
    </div>
    <ul class="loss-list">
      <li v-for="(l, i) in items" :key="i">
        <i :style="{ background: colorOf(l, i) }" />
        <span class="loss-name" :title="l.path">{{ l.name }}</span>
        <span class="loss-detail muted small" v-if="l.kind === 'absorbed' && l.volume !== undefined && l.volume > 0.0005">
          volume {{ (l.volume * 100).toFixed(1) }} % · surface {{ ((l.surface ?? 0) * 100).toFixed(1) }} %
        </span>
        <span class="loss-val">{{ (l.fraction * 100).toFixed(1) }} %</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import type { LossItem } from "../api";

defineProps<{ items: LossItem[] }>();

const PALETTE = ["#7c3aed", "#db2777", "#ea580c", "#ca8a04", "#0d9488", "#4f46e5", "#65a30d", "#be123c", "#0891b2"];
function colorOf(l: LossItem, i: number): string {
  if (l.kind === "exit") return "#16a34a";
  if (l.kind === "escaped") return "#94a3b8";
  if (l.kind === "error" || l.kind === "noise") return "#e11d48";
  return PALETTE[i % PALETTE.length];
}
</script>
