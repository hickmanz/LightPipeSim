<template>
  <div class="ana-tab">
    <p class="muted small">
      Rays are grouped by the <strong>route</strong> they took: the surfaces they met, in order, before reaching the exit. The numbered colours say which
      surface is which step. Click a route to see where it goes and where its light lands.
    </p>
    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-else-if="loading && !families.length" class="muted small"><div class="spinner small" /> Grouping the rays…</div>

    <table v-if="families.length" class="data-table compact">
      <thead><tr><th>Route</th><th>Share of exit light</th><th title="Mean number of bounces of these rays">Bounces</th></tr></thead>
      <tbody>
        <tr v-for="f in families" :key="f.id" class="clickable" :class="{ sel: selected === f.id }" @click="selected = f.id">
          <td class="route-cell"><RouteLabel :family="f" /></td>
          <td class="share"><span class="bar" :style="{ width: Math.min(80, f.fraction * 100 * 1.6) + 'px' }" /> {{ fmtPct(f.fraction, 1) }}</td>
          <td>{{ f.meanBounces.toFixed(1) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!loading && !error" class="muted small">No routes were logged for this run.</p>

    <div v-if="current" class="ana-detail">
      <div class="ana-detail-head">
        <strong>The selected route</strong>
        <span class="muted small">{{ fmtPct(current.fraction, 1) }} of the exit light · {{ current.meanBounces.toFixed(1) }} bounces on average</span>
        <span class="spacer" />
        <button class="btn primary small" title="See this route in the 3D model: its surfaces in the colours of the steps, where its light lands, and its rays" @click="view3d"><Box :size="14" /> View in 3D</button>
      </div>
      <ol v-if="steps.length" class="steps">
        <li><span class="num led-num">LED</span> <strong>{{ current.ledName }}</strong> <span class="muted small">emits the light</span></li>
        <li v-for="(s, i) in steps" :key="i">
          <span class="num" :style="{ background: s.color }">{{ i + 1 }}</span>
          <strong>{{ s.part }}</strong> <span v-if="s.face" class="face-tag">{{ s.face }}</span>
          <span v-if="s.desc" class="muted small"> — {{ s.desc }}</span>
        </li>
        <li><span class="num exit-num">✓</span> <strong>Exit surface</strong></li>
      </ol>
      <p v-else class="muted small">This light never meets one of your tracked surfaces: it goes from the LED to the exit surface, bouncing only inside the light pipe itself (total internal reflection).</p>

      <FootprintMap :ctx="ctx" kind="family" :id="current.id" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Box } from "lucide-vue-next";
import { api, type AnalysisFamily } from "../../api";
import { injectAnalysisView, type AnalysisCtx } from "../../composables/useAnalysisView";
import { describeSurface, routeColors, splitName } from "../../utils/analysisText";
import { fmtPct } from "../../utils/colormap";
import FootprintMap from "./FootprintMap.vue";
import RouteLabel from "./RouteLabel.vue";

const props = defineProps<{ ctx: AnalysisCtx }>();
const av = injectAnalysisView();

const families = ref<AnalysisFamily[]>([]);
const loading = ref(false);
const error = ref("");
const selected = ref<string | null>(null);
const current = computed(() => families.value.find((f) => f.id === selected.value) ?? null);

const colors = computed(() => routeColors(current.value?.route ?? []));
const groupOf = (g: number) => av.groups.value.find((x) => x.index === g);
/** The distinct surfaces of the route, in the order the light meets them. */
const steps = computed(() =>
  (current.value?.route ?? []).map((g) => {
    const gi = groupOf(g);
    const s = splitName(gi?.name ?? `group ${g}`);
    return { group: g, color: colors.value[g], part: s.part, face: s.face, desc: gi ? describeSurface(gi.geometry, av.frame.value) : "", info: gi };
  }),
);
const routeName = computed(() => steps.value.map((s) => (s.face ? `${s.part} · ${s.face}` : s.part)).join(" → ") || "straight to the exit");
let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.analysisFamilies(props.ctx.runId, { state: props.ctx.state, view: props.ctx.view });
    if (mine !== seq) return;
    families.value = r.families.slice(0, 25);
    error.value = "";
    if (!families.value.some((f) => f.id === selected.value)) selected.value = families.value[0]?.id ?? null;
  } catch (e) {
    if (mine === seq) {
      families.value = [];
      error.value = (e as Error).message;
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(() => [props.ctx.runId, props.ctx.state, props.ctx.view], load, { immediate: true });

/** See this route in the 3D model: its surfaces in step colours, where its light lands, and its rays. */
function view3d() {
  const f = current.value;
  if (!f) return;
  const seen = new Set<number>();
  const spots = steps.value
    .filter((s) => !seen.has(s.group) && seen.add(s.group))
    .map((s) => ({ label: s.info?.name ?? "", color: s.color, faces: (s.info?.faces ?? []).map((x) => ({ instance: x.instance, face: x.face })) }));
  av.viewSelection({
    id: `route:${f.id}:${props.ctx.detector}`,
    kind: "route",
    label: `Route ${routeName.value}`,
    spots,
    footprint: { kind: "family", id: f.id, detector: props.ctx.detector, vmax: props.ctx.vmax },
    rays: { filter: { family: f.id, outcome: "exit" }, label: `Route: ${f.ledName} → ${routeName.value}`, color: f.route.length ? "group" : "led", colors: colors.value },
    showRays: true,
  });
}
</script>

<style scoped>
.ana-tab { display: flex; flex-direction: column; gap: 8px; }
.route-cell { white-space: normal; }
tr.sel { background: var(--accent-3); }
.share { white-space: nowrap; }
.bar { display: inline-block; height: 8px; border-radius: 3px; margin-right: 4px; vertical-align: middle; background: var(--accent-9); }
.ana-detail { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--neutral-4); padding-top: 8px; }
.ana-detail-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; font-size: 0.82rem; }
.steps li { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.num { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 3px; border-radius: 9px; color: #fff; font-size: 0.7rem; font-weight: 700; align-self: center; }
.led-num { background: #ca8a04; }
.exit-num { background: #16a34a; }
.face-tag { color: var(--neutral-10); font-size: 0.74rem; }
.ana-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; align-items: start; }
.ana-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ana-sub { font-size: 0.82rem; font-weight: 600; }
</style>
