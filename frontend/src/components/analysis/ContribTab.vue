<template>
  <div class="ana-tab">
    <p class="muted small">
      Every ray that reaches the exit surface is followed back: which of your surfaces did it touch, and which one did it leave last? Click a surface to see
      where it is and where on the exit surface its light lands.
    </p>
    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-else-if="loading && !overview" class="muted small"><div class="spinner small" /> Reading the analysis…</div>

    <template v-if="overview">
      <table class="data-table compact ana-table">
        <thead>
          <tr>
            <th>Surface</th>
            <th title="Share of the exit light whose last reflection or crossing of a tagged surface was this one">Last surface</th>
            <th title="Share of the exit light that touched this surface at least once">Touched</th>
            <th title="Fraction of the emitted flux that arrives at this surface">Hit by</th>
            <th title="Fraction of the emitted flux this surface absorbs">Absorbs</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="overview.directFraction > 0">
            <td><i class="swatch" style="background: #f2c744" /> Straight from the LED</td>
            <td>{{ fmtPct(overview.directFraction, 1) }}</td>
            <td colspan="3" class="muted">no tagged surface on the way</td>
          </tr>
          <tr v-for="g in rows" :key="g.index" class="clickable" :class="{ sel: selected === g.index }" @click="select(g.index)">
            <td class="name-cell" :title="`${g.name}\n${describe(g)}`">
              <i class="swatch" :style="{ background: g.color }" />
              <span class="nm"><strong>{{ splitName(g.name).part }}</strong> <span v-if="splitName(g.name).face" class="face-tag">{{ splitName(g.name).face }}</span></span>
              <span v-if="describe(g)" class="where muted">{{ describe(g) }}</span>
            </td>
            <td><span class="bar" :style="{ width: Math.min(100, g.lastFraction * 100 * 2) + 'px', background: g.color }" /> {{ fmtPct(g.lastFraction, 1) }}</td>
            <td>{{ fmtPct(g.touchedFraction, 0) }}</td>
            <td>{{ fmtPct(g.incident, 1) }}</td>
            <td :class="{ bad: g.absorbedOfIncident > 0.15 }" :title="`${fmtPct(g.absorbedOfIncident, 1)} of what hits it`">{{ fmtPct(g.absorbed, 1) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="hidden > 0" class="muted small">{{ hidden }} more surfaces with little light are not listed.</p>

      <div v-if="sel" class="ana-detail">
        <div class="ana-detail-head">
          <strong><i class="swatch" :style="{ background: sel.color }" /> {{ sel.name }}</strong>
          <span class="muted small">{{ sel.faces.length }} face{{ sel.faces.length === 1 ? "" : "s" }} · {{ sel.areaMm2.toFixed(1) }} mm²</span>
          <span class="spacer" />
          <button class="btn primary small" title="See this surface in the 3D model, with where its light lands. The rays follow the choice below the map." @click="view3d"><Box :size="14" /> View in 3D</button>
        </div>
        <p v-if="describe(sel)" class="muted small ana-where">{{ describe(sel) }}</p>
        <FootprintMap v-model:mode="mode" :ctx="ctx" kind="group" :id="sel.index" modes />
      </div>
      <p v-else class="muted small">Click a surface above to see where it is and where its light lands.</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Box } from "lucide-vue-next";
import { api, type AnalysisGroupInfo, type AnalysisOverview } from "../../api";
import { injectAnalysisView, type AnalysisCtx } from "../../composables/useAnalysisView";
import { describeSurface, splitName } from "../../utils/analysisText";
import { fmtPct } from "../../utils/colormap";
import FootprintMap from "./FootprintMap.vue";

const props = defineProps<{ ctx: AnalysisCtx }>();
const av = injectAnalysisView();

const overview = ref<AnalysisOverview | null>(null);
const loading = ref(false);
const error = ref("");
const selected = ref<number | null>(null);

const MIN_SHARE = 0.0005;
const MAX_ROWS = 20;
const active = computed(() =>
  (overview.value?.groups ?? [])
    .filter((g) => g.lastFraction >= MIN_SHARE || g.touchedFraction >= MIN_SHARE || g.incident >= 0.005)
    .sort((a, b) => b.lastFraction - a.lastFraction || b.incident - a.incident),
);
const rows = computed(() => active.value.slice(0, MAX_ROWS));
const hidden = computed(() => (overview.value?.groups.length ?? 0) - rows.value.length);
const sel = computed(() => overview.value?.groups.find((g) => g.index === selected.value) ?? null);
const describe = (g: AnalysisGroupInfo) => describeSurface(g.geometry, av.frame.value);
let seq = 0;
async function loadOverview() {
  const mine = ++seq;
  loading.value = true;
  try {
    const o = await api.analysis(props.ctx.runId, { state: props.ctx.state, view: props.ctx.view, detector: props.ctx.detector });
    if (mine !== seq) return;
    overview.value = o;
    error.value = "";
    if (selected.value !== null && !o.groups.some((g) => g.index === selected.value)) selected.value = null;
    if (selected.value === null) selected.value = [...o.groups].sort((a, b) => b.lastFraction - a.lastFraction)[0]?.index ?? null;
  } catch (e) {
    if (mine === seq) {
      overview.value = null;
      error.value = (e as Error).message;
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
const select = (g: number) => (selected.value = g);
watch(() => [props.ctx.runId, props.ctx.state, props.ctx.view, props.ctx.detector], loadOverview, { immediate: true });

/** Which light the map (and the rays in 3D) are about: what left the surface last, or everything that touched it. */
const mode = ref<"last" | "touched">("last");

/** See this surface in the 3D model: lit up, with where its light lands and (on request) its rays. */
function view3d() {
  const g = sel.value;
  if (!g) return;
  const last = mode.value === "last";
  av.viewSelection({
    id: `surface:${g.index}:${mode.value}:${props.ctx.detector}`,
    kind: "surface",
    label: g.name,
    spots: [{ label: g.name, color: g.color, faces: g.faces.map((f) => ({ instance: f.instance, face: f.face })) }],
    footprint: { kind: "group", id: g.index, mode: mode.value, detector: props.ctx.detector, vmax: props.ctx.vmax },
    rays: { filter: last ? { lastGroup: g.index, outcome: "exit" } : { touched: g.index, outcome: "exit" }, label: `${last ? "Left" : "Touched"} “${g.name}”, reached the exit`, color: "group" },
    showRays: false,
  });
}
</script>

<style scoped>
.ana-tab { display: flex; flex-direction: column; gap: 8px; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; flex: none; }
.ana-table td:not(:first-child) { white-space: nowrap; }
.name-cell { display: grid; grid-template-columns: auto 1fr; column-gap: 0; max-width: 300px; }
.name-cell .swatch { grid-row: 1 / span 2; margin-top: 3px; }
.name-cell .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.face-tag { color: var(--neutral-10); font-size: 0.74rem; }
.name-cell .where { grid-column: 2; font-size: 0.7rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar { display: inline-block; height: 8px; border-radius: 3px; margin-right: 4px; vertical-align: middle; }
tr.sel { background: var(--accent-3); }
.ana-detail { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--neutral-4); padding-top: 8px; }
.ana-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ana-where { margin: 0; }
.ana-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; align-items: start; }
.ana-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ana-sub { font-size: 0.82rem; font-weight: 600; }
</style>
