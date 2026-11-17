<template>
  <div class="results">
    <div class="res-bar">
      <label class="mini inline">
        <span>State</span>
        <select v-model="stateId">
          <option v-for="s in result?.states ?? []" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </label>
      <label v-if="(result?.detectors.length ?? 0) > 1" class="mini inline">
        <span>Exit surface</span>
        <select v-model.number="detIdx">
          <option v-for="(d, i) in result?.detectors ?? []" :key="d.id" :value="i">{{ d.name }}</option>
        </select>
      </label>
      <label class="mini inline" title="Luminance inside the viewing cone, or exitance into all directions">
        <span>Quantity</span>
        <select v-model="analysis.view">
          <option value="cone">Luminance (viewing cone)</option>
          <option value="all">Exitance (all directions)</option>
        </select>
      </label>
      <label class="mini inline" title="Gaussian smoothing before min / max / hotspot statistics">
        <span>Smoothing</span>
        <select v-model.number="analysis.smooth">
          <option :value="0">none</option>
          <option :value="1">1 px</option>
          <option :value="2">2 px</option>
          <option :value="3">3 px</option>
        </select>
      </label>
      <label class="mini inline" title="Flag a local maximum this much above the average">
        <span>Hotspot ≥</span>
        <select v-model.number="analysis.hotspot_ratio">
          <option v-for="r in [1.1, 1.25, 1.5, 2]" :key="r" :value="r">{{ r }}× avg</option>
        </select>
      </label>
      <label class="check small"><input v-model="logScale" type="checkbox" /> log scale</label>
      <span class="spacer" />
      <div class="tgroup">
        <button class="tbtn" :class="{ on: compareWith !== null }" title="Compare with another run" @click="toggleCompare"><GitCompare :size="15" /> Compare</button>
        <a class="tbtn" :href="api.exportUrl(runId)" download title="Download images, metrics and results (zip)"><Download :size="15" /> Export</a>
      </div>
    </div>

    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-if="loading && !result" class="stage-msg"><div class="spinner small" /> Loading results…</div>

    <CompareView v-if="compareWith !== null && result" :run-id="runId" :other-id="compareWith" :state="stateId" :detector="detIdx" :analysis="apiAnalysis" :options="compareOptions" :aspect="det ? det.uExtentMm / det.vExtentMm : 1" @change-other="compareWith = $event" @close="compareWith = null" />

    <template v-else-if="result && det">
      <!-- key figures -->
      <div class="kpis">
        <div class="kpi big">
          <div class="kpi-val">{{ fmtPct(det.efficiency) }}</div>
          <div class="kpi-label">Efficiency</div>
          <div class="kpi-sub">{{ fmtNum(det.exitLm) }} lm out of {{ fmtNum(result.emitted.lm) }} lm emitted</div>
        </div>
        <div class="kpi">
          <div class="kpi-val">{{ fmtNum(det.stats.mean) }}</div>
          <div class="kpi-label">Average {{ det.quantity }} <span class="muted">{{ det.unit }}</span></div>
          <div class="kpi-sub">max {{ fmtNum(det.stats.max) }} · min {{ fmtNum(det.stats.min) }}</div>
        </div>
        <div class="kpi">
          <div class="kpi-val">{{ fmtPct(det.stats.minOverMax, 0) }}</div>
          <div class="kpi-label">Uniformity (min / max)</div>
          <div class="kpi-sub">min/avg {{ fmtPct(det.stats.minOverAvg, 0) }} · CV {{ fmtPct(det.stats.cv, 0) }}</div>
        </div>
        <div class="kpi" :class="{ warn: det.hotspots.length > 0 }">
          <div class="kpi-val">{{ det.hotspots.length }}</div>
          <div class="kpi-label">Hotspots</div>
          <div class="kpi-sub">{{ det.hotspots.length ? `worst ${det.hotspots[0].ratio.toFixed(2)}× average` : `none above ${analysis.hotspot_ratio}× average` }}</div>
        </div>
        <div v-if="det.color" class="kpi">
          <div class="kpi-val">{{ det.color.cct }} K</div>
          <div class="kpi-label">Colour (average)</div>
          <div class="kpi-sub">x {{ det.color.x.toFixed(3) }}, y {{ det.color.y.toFixed(3) }} · max Δu′v′ {{ det.color.maxDuv.toFixed(3) }}</div>
        </div>
      </div>

      <div v-if="noisy" class="notice info"><Info :size="15" /><span>Only {{ result.rays.toLocaleString() }} rays per channel were used: maps and colour are noisy. Run again with more rays for smooth results.</span></div>
      <div v-for="w in result.warnings" :key="w" class="notice warn"><AlertTriangle :size="15" /><span>{{ w }}</span></div>

      <!-- maps -->
      <section class="res-card">
        <HeatMap
          :title="`${det.quantity === 'luminance' ? 'Luminance' : 'Exitance'} at the exit surface — ${det.name}`"
          :values="det[det.quantity === 'luminance' ? 'luminance' : 'exitance']"
          :valid="det.valid"
          :vmin="logScale ? mapMax * 0.001 : 0"
          :vmax="mapMax"
          :unit="det.unit"
          :u-mm="det.uExtentMm"
          :v-mm="det.vExtentMm"
          :hotspots="det.hotspots"
          :roi="analysis.roi"
          :log="logScale"
          selectable
          @roi="setRoi"
        />
        <p class="muted small">Drag on the map to analyse a region, double-click to reset. {{ roiText }}</p>
      </section>

      <AnalysisPanel v-if="anaCtx" :ctx="anaCtx" />

      <div class="res-grid">
        <section v-if="det.appearance" class="res-card">
          <HeatMap title="What it looks like (true colour)" :values="det.luminance" :valid="det.valid" :vmax="1" :u-mm="det.uExtentMm" :v-mm="det.vExtentMm" :rgb="det.appearance" />
          <p class="muted small">Exposure: the brightest 2 % of the surface is white.</p>
        </section>
        <section v-if="det.duvMap" class="res-card">
          <HeatMap title="Colour difference Δu′v′ from the average" :values="det.duvMap" :valid="det.mask" :vmin="0" :vmax="Math.max(0.01, det.color?.p95Duv ?? 0.01)" unit="Δu′v′" :u-mm="det.uExtentMm" :v-mm="det.vExtentMm" />
          <p class="muted small">Δu′v′ below about 0.005 is hard to notice side by side.</p>
        </section>
      </div>

      <div class="res-grid">
        <section class="res-card">
          <LineChart title="Along the length (u)" :series="[{ label: 'avg over width', color: '#2563eb', x: uAxis, y: det.profileU }]" x-label="mm" :y-label="det.unit" />
        </section>
        <section v-if="det.nv > 3" class="res-card">
          <LineChart title="Across the width (v)" :series="[{ label: 'avg over length', color: '#2563eb', x: vAxis, y: det.profileV }]" x-label="mm" :y-label="det.unit" />
        </section>
        <section class="res-card">
          <LineChart
            title="Light by angle from the surface normal"
            :series="angularSeries"
            x-label="degrees"
            y-label="relative intensity / Δu′v′"
          />
        </section>
        <section v-if="det.chromaticityXY && det.color" class="res-card">
          <ChromaticityPlot :xy="det.chromaticityXY" :mask="det.mask" :mean="{ u: det.color.u, v: det.color.v }" />
        </section>
      </div>

      <!-- per LED -->
      <section class="res-card">
        <div class="hm-title"><span>Contribution of each LED</span></div>
        <div class="led-maps">
          <div v-for="l in det.leds" :key="l.id" class="led-map">
            <HeatMap v-if="l.map" :axes="false" :title="l.name" :values="l.map" :valid="det.valid" :vmax="mapMax" :u-mm="det.uExtentMm" :v-mm="det.vExtentMm" :unit="det.unit" />
            <div class="muted small">{{ fmtPct(l.shareOfExit, 0) }} of the exit light · efficiency {{ fmtPct(l.efficiency) }}</div>
          </div>
        </div>
        <table class="data-table">
          <thead><tr><th>LED</th><th>Emitted lm</th><th>At exit lm</th><th>Efficiency</th><th>Share</th></tr></thead>
          <tbody>
            <tr v-for="l in det.leds" :key="l.id"><td>{{ l.name }}</td><td>{{ fmtNum(l.emittedLm) }}</td><td>{{ fmtNum(l.exitLm) }}</td><td>{{ fmtPct(l.efficiency) }}</td><td>{{ fmtPct(l.shareOfExit, 0) }}</td></tr>
          </tbody>
        </table>
      </section>

      <!-- where did the light go -->
      <section class="res-card">
        <div class="hm-title"><span>Where the light goes (share of emitted flux)</span></div>
        <LossBar :items="result.loss" />
        <p class="muted small">Absorption in the light pipe is split into volume (material) and surface losses. “Escaped” leaves through any other surface, e.g. the open sides.</p>
      </section>

      <RenderPanel :run-id="runId" :state="stateId" />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { AlertTriangle, Download, GitCompare, Info } from "lucide-vue-next";
import { api, type Analysis, type DetectorResult, type StateResult } from "../api";
import { fmtNum, fmtPct } from "../utils/colormap";
import HeatMap from "./HeatMap.vue";
import LineChart from "./LineChart.vue";
import LossBar from "./LossBar.vue";
import ChromaticityPlot from "./ChromaticityPlot.vue";
import CompareView from "./CompareView.vue";
import RenderPanel from "./RenderPanel.vue";
import AnalysisPanel from "./AnalysisPanel.vue";
import type { AnalysisCtx } from "../composables/useAnalysisView";

const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ loaded: [result: StateResult, detector: number, vmax: number]; "request-compare": []}>();

const stateId = ref<string | undefined>(undefined);
const detIdx = ref(0);
const result = ref<StateResult | null>(null);
const loading = ref(false);
const error = ref("");
const logScale = ref(false);
const compareWith = ref<string | null>(null);
const analysis = reactive<{ view: "cone" | "all"; smooth: number; hotspot_ratio: number; roi: number[] | null }>({ view: "cone", smooth: 1, hotspot_ratio: 1.25, roi: null });

const apiAnalysis = computed<Analysis>(() => ({
  view: analysis.view,
  smooth: analysis.smooth,
  hotspot_ratio: analysis.hotspot_ratio,
  roi: analysis.roi ? (analysis.roi as [number, number, number, number]) : undefined,
}));
const compareOptions = computed(() => ({ log: logScale.value }));

const det = computed<DetectorResult | null>(() => result.value?.detectors[detIdx.value] ?? null);
const mapMax = computed(() => (det.value?.stats.max ?? 1) * 1.02 || 1);
/** What the light path analysis needs to know about the map on screen. */
const anaCtx = computed<AnalysisCtx | null>(() => {
  const d = det.value;
  if (!d || !result.value) return null;
  return {
    runId: props.runId,
    state: result.value.state.id,
    view: analysis.view,
    detector: detIdx.value,
    uMm: d.uExtentMm,
    vMm: d.vExtentMm,
    valid: d.valid,
    values: d[d.quantity === "luminance" ? "luminance" : "exitance"],
    roi: analysis.roi,
    vmax: mapMax.value,
    unit: d.unit,
  };
});
const noisy = computed(() => (result.value?.rays ?? 0) < 100000);
const uAxis = computed(() => (det.value ? det.value.profileU.map((_, i) => ((i + 0.5) / det.value!.nu) * det.value!.uExtentMm) : []));
const vAxis = computed(() => (det.value ? det.value.profileV.map((_, i) => ((i + 0.5) / det.value!.nv) * det.value!.vExtentMm) : []));
const roiText = computed(() => (analysis.roi ? `Statistics use the selected region (${analysis.roi.map((x) => (x * 100).toFixed(0)).join(", ")} %).` : "Statistics use the whole exit surface."));
const angularSeries = computed(() => {
  const a = det.value?.angular;
  if (!a) return [];
  const out = [{ label: "intensity (relative)", color: "#2563eb", x: a.angles, y: a.relative as (number | null)[] }];
  if (a.duvFromNormal) out.push({ label: "Δu′v′ vs normal (×10)", color: "#db2777", x: a.angles, y: a.duvFromNormal.map((v) => v * 10) as (number | null)[] });
  return out;
});

let timer: number | undefined;
let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.results(props.runId, stateId.value, apiAnalysis.value, true);
    if (mine !== seq) return;
    result.value = r;
    if (!stateId.value) stateId.value = r.state.id;
    error.value = "";
    if (detIdx.value >= r.detectors.length) detIdx.value = 0;
    emit("loaded", r, detIdx.value, (r.detectors[detIdx.value]?.stats.max ?? 1) * 1.02);
  } catch (e) {
    if (mine === seq) error.value = (e as Error).message;
  } finally {
    if (mine === seq) loading.value = false;
  }
}
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(load, 120);
}
watch(() => props.runId, () => {
  stateId.value = undefined;
  result.value = null;
  analysis.roi = null;
  compareWith.value = null;
  schedule();
}, { immediate: true });
watch([stateId, () => analysis.view, () => analysis.smooth, () => analysis.hotspot_ratio, () => analysis.roi], schedule);
watch(detIdx, () => result.value && emit("loaded", result.value, detIdx.value, mapMax.value));
onBeforeUnmount(() => window.clearTimeout(timer));

function setRoi(r: number[] | null) {
  analysis.roi = r;
}
function toggleCompare() {
  if (compareWith.value !== null) compareWith.value = null;
  else compareWith.value = "";
}
</script>
