<template>
  <div class="ana-tab">
    <p class="muted small">
      Where is the exit surface darker or brighter than it should be, and which of your surfaces could fix it? The estimate scales the footprint of each surface
      on its own, so treat it as a pointer to the surfaces worth changing first, then run again to check.
    </p>
    <div class="tab-actions">
      <label class="mini inline" title="Level the surface should have. Leave empty to aim for the current average.">
        <span>Target level ({{ ctx.unit }})</span>
        <input v-model.number="target" type="number" min="0" step="any" placeholder="average" />
      </label>
      <span v-if="ctx.roi" class="muted small">Only the region selected on the exit map counts.</span>
    </div>
    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-else-if="loading && !g" class="muted small"><div class="spinner small" /> Fitting…</div>

    <template v-if="g">
      <div class="ana-split">
        <HeatMap
          title="Deficit (red: darker than the target, blue: brighter)"
          :values="g.deficit"
          :valid="g.valid"
          :vmin="-dmax"
          :vmax="dmax"
          :unit="g.unit"
          :u-mm="ctx.uMm"
          :v-mm="ctx.vMm"
          diverging
        />
        <div class="ana-stats">
          <table class="data-table compact">
            <thead><tr><th></th><th>Now</th><th>If the advice is followed</th></tr></thead>
            <tbody>
              <tr><td>CV (spread)</td><td>{{ fmtPct(g.current.cv, 1) }}</td><td :class="better(g.predicted.cv, g.current.cv)">{{ fmtPct(g.predicted.cv, 1) }}</td></tr>
              <tr><td>Darkest / average</td><td>{{ fmtPct(g.current.minOverAvg, 0) }}</td><td :class="better(g.current.minOverAvg, g.predicted.minOverAvg)">{{ fmtPct(g.predicted.minOverAvg, 0) }}</td></tr>
              <tr><td>Brightest / average</td><td>{{ fmtPct(g.current.maxOverAvg, 0) }}</td><td :class="better(g.predicted.maxOverAvg, g.current.maxOverAvg)">{{ fmtPct(g.predicted.maxOverAvg, 0) }}</td></tr>
            </tbody>
          </table>
          <p class="muted small">{{ g.note }}</p>
        </div>
      </div>

      <h4 class="ana-h">Surfaces to change</h4>
      <table v-if="g.suggestions.length" class="data-table compact">
        <thead><tr><th>Surface</th><th title="Share of the light on the exit surface that came off it">Share</th><th>Scale</th><th>Change</th><th>Advice</th></tr></thead>
        <tbody>
          <tr v-for="s in g.suggestions" :key="s.group" :class="{ quiet: Math.abs(s.changePct) < 5 }">
            <td><i class="swatch" :style="{ background: s.color }" /> {{ s.name }}</td>
            <td>{{ fmtPct(s.share, 1) }}</td>
            <td>× {{ s.scale.toFixed(2) }}</td>
            <td :class="s.changePct > 5 ? 'good' : s.changePct < -5 ? 'bad' : ''">{{ s.changePct > 0 ? "+" : "" }}{{ s.changePct.toFixed(0) }} %</td>
            <td class="advice">{{ s.advice }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted small">No surface stands out: the light is already spread as evenly as these surfaces can make it.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle } from "lucide-vue-next";
import { api, type Guidance } from "../../api";
import type { AnalysisCtx } from "../../composables/useAnalysisView";
import { fmtPct } from "../../utils/colormap";
import HeatMap from "../HeatMap.vue";

const props = defineProps<{ ctx: AnalysisCtx }>();
const g = ref<Guidance | null>(null);
const loading = ref(false);
const error = ref("");
const target = ref<number | null>(null);

const dmax = computed(() => Math.max(1e-9, ...(g.value?.deficit ?? []).map((r) => Math.max(...r.map(Math.abs)))));
const better = (a: number, b: number) => (a < b - 1e-6 ? "good" : "");

let seq = 0;
let timer: number | undefined;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.analysisGuidance(props.ctx.runId, {
      state: props.ctx.state,
      view: props.ctx.view,
      detector: props.ctx.detector,
      roi: props.ctx.roi,
      target: target.value && target.value > 0 ? target.value : undefined,
    });
    if (mine !== seq) return;
    g.value = r;
    error.value = "";
  } catch (e) {
    if (mine === seq) {
      g.value = null;
      error.value = (e as Error).message;
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(
  () => [props.ctx.runId, props.ctx.state, props.ctx.view, props.ctx.detector, props.ctx.roi, target.value],
  () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(load, 250);
  },
  { immediate: true },
);
</script>

<style scoped>
.ana-tab { display: flex; flex-direction: column; gap: 8px; }
.ana-h { margin: 6px 0 0; font-size: 0.82rem; color: var(--neutral-11); }
.ana-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; align-items: start; }
.ana-stats { display: flex; flex-direction: column; gap: 6px; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
tr.quiet { opacity: 0.6; }
.advice { text-align: right; white-space: nowrap; }
.mini input { width: 110px; }
</style>
