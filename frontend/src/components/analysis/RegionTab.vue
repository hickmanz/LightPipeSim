<template>
  <div class="ana-tab">
    <p class="muted small">
      Draw a box or an outline around a part of the exit surface (a dark spot, a hot spot, a LED zone) to see where the light that lands there comes from.
      Double-click the map to clear the outline.
    </p>
    <div class="tab-actions">
      <button class="btn small" :class="{ on: tool === 'box' }" @click="tool = 'box'"><Square :size="14" /> Box</button>
      <button class="btn small" :class="{ on: tool === 'lasso' }" @click="tool = 'lasso'"><Lasso :size="14" /> Outline</button>
      <button class="btn small" :disabled="!polygon" @click="polygon = null"><X :size="14" /> Clear</button>
      <span class="muted small">{{ polygon ? `${fmtPct(report?.fluxFraction ?? 0, 1)} of the exit light lands inside` : "nothing selected yet" }}</span>
    </div>

    <HeatMap
      title="Exit surface"
      :values="ctx.values"
      :valid="ctx.valid"
      :vmin="0"
      :vmax="ctx.vmax"
      :unit="ctx.unit"
      :u-mm="ctx.uMm"
      :v-mm="ctx.vMm"
      :region-tool="tool"
      :region="polygon"
      @region="polygon = $event"
    />

    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-if="loading" class="muted small"><div class="spinner small" /> Tracing the light back…</div>

    <template v-if="report && polygon">
      <p v-if="!report.byGroup.length" class="muted small">No logged light lands in this region (it may be too small, or outside the rays that were recorded).</p>
      <template v-else>
        <h4 class="ana-h">Which surface did it leave last?</h4>
        <BarList :items="groupItems" clickable @pick="pickGroup" />
        <h4 class="ana-h">Which LED?</h4>
        <BarList :items="report.byLed.map((l) => ({ label: l.name, value: l.fraction }))" />
        <h4 class="ana-h">Routes <span class="muted small">(click a surface or a route to look at just that part in 3D)</span></h4>
        <ul class="fam-list">
          <li v-for="f in report.families" :key="f.id" class="clickable" :class="{ on: sub?.key === `f:${f.id}` }" @click="pickFamily(f)">
            <RouteLabel :family="f" />
            <span class="spacer" />
            <span class="muted small">{{ f.meanBounces.toFixed(1) }} bounces</span>
            <strong>{{ fmtPct(f.fraction, 0) }}</strong>
          </li>
        </ul>
        <div class="ana-split">
          <div>
            <h4 class="ana-h">Number of bounces <span class="muted small">(mean {{ report.meanBounces?.toFixed(1) }})</span></h4>
            <BarList :items="report.byBounces.map((b) => ({ label: b.label, value: b.fraction }))" />
          </div>
          <div>
            <h4 class="ana-h">Per ray on the way</h4>
            <BarList :items="report.byEvent.map((e) => ({ label: e.name, value: e.perRay / eventMax, text: e.perRay.toFixed(1) }))" />
          </div>
        </div>
        <div class="tab-actions">
          <button class="btn primary small" @click="view3d"><Box :size="14" /> View in 3D</button>
          <span class="muted small">{{ sub ? `Just: ${sub.label}` : "All the light that lands in the region" }}</span>
          <button v-if="sub" class="btn small" @click="sub = null"><X :size="14" /> All of it</button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Lasso, Square, Box, X } from "lucide-vue-next";
import { api, type AnalysisFamily, type RaysFilter, type RegionReport } from "../../api";
import { injectAnalysisView, type AnalysisCtx } from "../../composables/useAnalysisView";
import { routeColors } from "../../utils/analysisText";
import { fmtPct } from "../../utils/colormap";
import HeatMap from "../HeatMap.vue";
import BarList from "../BarList.vue";
import RouteLabel from "./RouteLabel.vue";

const props = defineProps<{ ctx: AnalysisCtx }>();
const av = injectAnalysisView();

const tool = ref<"box" | "lasso">("box");
const polygon = ref<number[][] | null>(null);
const report = ref<RegionReport | null>(null);
const loading = ref(false);
const error = ref("");

const groupItems = computed(() => (report.value?.byGroup ?? []).slice(0, 12).map((g) => ({ label: g.group < 0 ? "Straight from the LED" : g.name, value: g.fraction, color: g.group < 0 ? "#f2c744" : g.color })));
const eventMax = computed(() => Math.max(1, ...(report.value?.byEvent ?? []).map((e) => e.perRay)));

let seq = 0;
async function load() {
  const mine = ++seq;
  if (!polygon.value) {
    report.value = null;
    error.value = "";
    return;
  }
  loading.value = true;
  try {
    const r = await api.analysisRegion(props.ctx.runId, { polygon: polygon.value, detector: props.ctx.detector, state: props.ctx.state, view: props.ctx.view });
    if (mine !== seq) return;
    report.value = r;
    error.value = "";
  } catch (e) {
    if (mine === seq) {
      report.value = null;
      error.value = (e as Error).message;
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch([polygon, () => props.ctx.runId, () => props.ctx.state, () => props.ctx.view, () => props.ctx.detector], load);
watch(() => props.ctx.runId, () => (polygon.value = null));

/** A part of the region (one surface it left last, or one route) to look at on its own. */
const sub = ref<{ key: string; label: string; extra: RaysFilter; route?: number[] } | null>(null);
watch(polygon, () => (sub.value = null));
function pickGroup(i: number) {
  const g = report.value?.byGroup[i];
  if (!g) return;
  const key = `g:${g.group}`;
  sub.value = sub.value?.key === key ? null : { key, label: g.group < 0 ? "straight from the LED" : `left “${g.name}” last`, extra: g.group >= 0 ? { lastGroup: g.group } : {} };
}
function pickFamily(f: AnalysisFamily) {
  const key = `f:${f.id}`;
  sub.value = sub.value?.key === key ? null : { key, label: `route ${f.label}`, extra: { family: f.id }, route: f.route };
}

/** See the light that lands in the region as rays in the 3D model. */
function view3d() {
  if (!polygon.value) return;
  const s = sub.value;
  av.viewSelection({
    id: `region:${s?.key ?? "all"}:${JSON.stringify(polygon.value)}`,
    kind: "region",
    label: s ? `Region, ${s.label}` : "Light that lands in the region",
    spots: [],
    footprint: null,
    rays: {
      filter: { region: { detector: props.ctx.detector, polygon: polygon.value }, outcome: "exit", ...(s?.extra ?? {}) },
      label: s ? `Region, ${s.label}` : "Light that lands in the selected region",
      ...(s?.route?.length ? { color: "group" as const, colors: routeColors(s.route) } : { color: "led" as const }),
    },
    showRays: true,
  });
}</script>

<style scoped>
.ana-tab { display: flex; flex-direction: column; gap: 8px; }
.ana-h { margin: 6px 0 0; font-size: 0.82rem; color: var(--neutral-11); }
.ana-split { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.fam-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.fam-list li { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; padding: 3px 6px; border-radius: var(--radius-sm); }
.fam-list li.clickable { cursor: pointer; }
.fam-list li.clickable:hover { background: var(--neutral-2); }
.fam-list li.on { background: var(--accent-3); }
</style>
