<template>
  <div class="fp">
    <div class="fp-head">
      <strong class="fp-title">{{ what }}</strong>
      <span class="muted small">{{ share }}</span>
      <span class="spacer" />
      <div v-if="modes && !direct" class="seg" role="group" aria-label="Which light">
        <button :class="{ on: mode === 'last' }" title="Light whose last bounce on one of your surfaces was this one" @click="mode = 'last'">Left it last</button>
        <button :class="{ on: mode === 'touched' }" title="Light that hit this surface at some point on its way" @click="mode = 'touched'">Touched it</button>
      </div>
    </div>
    <HeatMap
      v-if="map"
      :values="map.values"
      :valid="ctx.valid"
      :vmin="0"
      :vmax="vmax"
      :unit="map.unit"
      :u-mm="ctx.uMm"
      :v-mm="ctx.vMm"
    />
    <div v-else-if="loading" class="muted small"><div class="spinner small" /> Loading…</div>
    <p v-if="map && tiny" class="muted small">
      Only a little of the exit light {{ direct ? "comes straight from the LED" : mode === "touched" || kind === "family" ? "comes this way" : "leaves this surface last" }}.
      <template v-if="!sameScale">The colours are stretched to this map's own brightest spot, so read the numbers on the scale, not the colours.</template>
      <template v-else>With the exit map's scale it is faint by design.</template>
      <template v-if="kind === 'group' && mode === 'last' && !direct"> “Touched it” also counts light that bounced off it earlier.</template>
    </p>
    <div class="fp-foot">
      <label class="check small" title="Off: the colours are stretched so the brightest spot of this map is red. On: the same colours as the exit map, so you can compare brightness directly.">
        <input v-model="sameScale" type="checkbox" /> same colour scale as the exit map
      </label>
      <span class="spacer" />
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
// The footprint of a surface (or of a route) on the exit surface: where its light lands. It is scaled to its own brightest
// spot by default, because a surface that carries 2 % of the light would otherwise vanish next to the exit map's scale.
import { computed, ref, watch } from "vue";
import { api, type AnalysisMap } from "../../api";
import type { AnalysisCtx } from "../../composables/useAnalysisView";
import { fmtPct } from "../../utils/colormap";
import HeatMap from "../HeatMap.vue";

const props = withDefaults(
  defineProps<{
    ctx: AnalysisCtx;
    kind: "group" | "family";
    /** Group index or family id. */
    id: number | string | null;
    /** Offer the choice between light that left the surface last and light that touched it. */
    modes?: boolean;
  }>(),
  { modes: false },
);
/** Which light a surface's map shows (the parent can read it, e.g. to show the same rays in 3D). */
const mode = defineModel<"last" | "touched">("mode", { default: "last" });
const sameScale = ref(false);
const map = ref<AnalysisMap | null>(null);
const loading = ref(false);

/** "Straight from the LED" (group -1) touched no surface, so only the "left it last" view exists for it. */
const direct = computed(() => props.kind === "group" && typeof props.id === "number" && props.id < 0);
const effMode = computed(() => (direct.value ? "last" : mode.value));

const what = computed(() => {
  if (props.kind === "family") return "Where the light of this route lands";
  if (direct.value) return "Where the light that comes straight from the LED lands";
  return mode.value === "last" ? "Where the light that left it last lands" : "Where the light that touched it lands";
});
const share = computed(() => (map.value ? `${fmtPct(map.value.fraction, map.value.fraction < 0.1 ? 1 : 0)} of the exit light` : ""));
const tiny = computed(() => !!map.value && map.value.fraction < 0.01);
const ownMax = computed(() => (map.value ? Math.max(1e-9, ...map.value.values.map((r) => Math.max(...r))) * 1.02 : 1));
const vmax = computed(() => (sameScale.value ? props.ctx.vmax : ownMax.value));
let seq = 0;
async function load() {
  const mine = ++seq;
  if (props.id === null) {
    map.value = null;
    return;
  }
  loading.value = true;
  try {
    const c = props.ctx;
    const m =
      props.kind === "group"
        ? await api.analysisMap(c.runId, { group: props.id as number, mode: effMode.value, state: c.state, view: c.view, detector: c.detector })
        : await api.analysisFamilyMap(c.runId, { family: props.id as string, state: c.state, view: c.view, detector: c.detector });
    if (mine === seq) map.value = m;
  } catch {
    if (mine === seq) map.value = null;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(() => [props.kind, props.id, effMode.value, props.ctx.runId, props.ctx.state, props.ctx.view, props.ctx.detector], load, { immediate: true });
</script>

<style scoped>
.fp { display: flex; flex-direction: column; gap: 6px; }
.fp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fp-title { font-size: 0.82rem; }
.fp-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.seg { display: inline-flex; border: 1px solid var(--neutral-5); border-radius: var(--radius-md); overflow: hidden; }
.seg button { border: 0; background: var(--neutral-1); font: inherit; font-size: 0.75rem; padding: 3px 9px; cursor: pointer; color: var(--neutral-11); }
.seg button + button { border-left: 1px solid var(--neutral-5); }
.seg button.on { background: var(--accent-3); color: var(--neutral-12); font-weight: 600; }
</style>
