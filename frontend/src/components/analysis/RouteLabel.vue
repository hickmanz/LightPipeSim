<template>
  <span class="route" :title="title">
    <span class="led">{{ family.ledName }}</span>
    <template v-if="family.route.length">
      <template v-for="(g, i) in family.route" :key="i">
        <span class="arrow">→</span>
        <span class="chip" :style="{ '--c': colors[g] }" :title="nameOf(g)">
          <b class="num">{{ i + 1 }}</b>
          <span class="txt">{{ short(g) }}</span>
        </span>
      </template>
      <span v-if="family.routeLength > family.route.length" class="arrow" :title="`${family.routeLength - family.route.length} more surfaces after these`">→ … +{{ family.routeLength - family.route.length }}</span>
    </template>
    <span v-else class="arrow direct">→ straight to the exit</span>
    <template v-if="family.route.length">
      <span class="arrow">→</span><span class="exit">Exit</span>
    </template>
  </span>
</template>

<script setup lang="ts">
// A route as a sentence: the LED, the surfaces it meets in order (numbered, each in its own colour) and the exit.
import { computed } from "vue";
import type { AnalysisFamily } from "../../api";
import { injectAnalysisView } from "../../composables/useAnalysisView";
import { routeColors, splitName } from "../../utils/analysisText";

const props = defineProps<{ family: AnalysisFamily }>();
const av = injectAnalysisView();
const colors = computed(() => routeColors(props.family.route));
const nameOf = (g: number) => av.groups.value.find((x) => x.index === g)?.name ?? `group ${g}`;
const short = (g: number) => {
  const s = splitName(nameOf(g));
  return s.face ? `${s.part} · ${s.face}` : s.part;
};
const title = computed(() => `${props.family.ledName} → ${props.family.route.map(nameOf).join(" → ") || "straight to the exit"}`);
</script>

<style scoped>
.route { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; line-height: 1.5; }
.led { font-weight: 600; }
.arrow { color: var(--neutral-9); }
.direct { color: var(--neutral-11); }
.chip {
  display: inline-flex; align-items: center; gap: 4px; padding: 0 6px 0 2px; border-radius: 999px;
  border: 1.5px solid var(--c); background: color-mix(in srgb, var(--c) 12%, transparent); font-size: 0.76rem; max-width: 230px;
}
.num { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: var(--c); color: #fff; font-size: 0.68rem; flex: none; }
.txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.exit { color: var(--radix-green-9, #16a34a); font-weight: 600; }
</style>
