<template>
  <ul class="barlist">
    <li v-for="(it, i) in items" :key="i" :class="{ clickable: clickable, selected: selected === i }" @click="clickable && emit('pick', i)">
      <i v-if="it.color" class="bl-dot" :style="{ background: it.color }" />
      <span class="bl-name" :title="it.label">{{ it.label }}</span>
      <span class="bl-track"><span class="bl-fill" :style="{ width: Math.min(100, Math.max(0, it.value * 100 * scale)) + '%', background: it.color || 'var(--accent-9)' }" /></span>
      <span class="bl-val">{{ it.text ?? fmtPct(it.value, it.value < 0.1 ? 1 : 0) }}</span>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { fmtPct } from "../utils/colormap";

withDefaults(defineProps<{ items: { label: string; value: number; color?: string; text?: string }[]; clickable?: boolean; selected?: number | null; scale?: number }>(), {
  clickable: false,
  selected: null,
  scale: 1,
});
const emit = defineEmits<{ pick: [index: number] }>();
</script>

<style scoped>
.barlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.barlist li { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; padding: 2px 4px; border-radius: var(--radius-sm); }
.barlist li.clickable { cursor: pointer; }
.barlist li.clickable:hover { background: var(--neutral-2); }
.barlist li.selected { background: var(--accent-3); }
.bl-dot { width: 11px; height: 11px; border-radius: 3px; flex: none; }
.bl-name { flex: 0 1 44%; min-width: 80px; overflow: hidden; line-height: 1.2; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.bl-track { flex: 1; height: 8px; background: var(--neutral-3); border-radius: 4px; overflow: hidden; min-width: 40px; }
.bl-fill { display: block; height: 100%; border-radius: 4px; }
.bl-val { min-width: 46px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
</style>
