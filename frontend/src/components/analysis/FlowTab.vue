<template>
  <div class="ana-tab">
    <p class="muted small">
      Follow the light from the LED to the exit surface. Each band is a share of the exit light: it runs from the LED, past the surfaces it meets (in the order it
      meets them) and lands on a part of the exit surface. <strong>Click a surface or a part of the exit</strong> to follow only the light that goes through it.
    </p>
    <div v-if="error" class="notice warn"><AlertTriangle :size="15" /><span>{{ error }}</span></div>
    <div v-else-if="loading && !data" class="muted small"><div class="spinner small" /> Following the light…</div>

    <template v-if="data && layout">
      <div class="flow-wrap">
        <svg class="flow" :viewBox="`0 0 ${W} ${layout.height}`" role="img" aria-label="Flow of light from the LED, along surfaces, to the exit surface">
          <g v-for="(h, i) in layout.heads" :key="'h' + i">
            <text :x="h.x" y="12" class="head">{{ h.text }}</text>
          </g>
          <g transform="translate(0,22)">
            <path
              v-for="l in layout.links"
              :key="l.id"
              :d="l.d"
              fill="none"
              :stroke="l.color"
              :stroke-width="l.h"
              :opacity="linkOpacity(l)"
              class="link"
              @click="pick(l.dst)"
            >
              <title>{{ l.src.label }} → {{ l.dst.label }}: {{ fmtPct(l.value, 1) }} of the exit light</title>
            </path>
            <g v-for="n in layout.nodes" :key="n.id" class="node" :class="{ sel: selId === n.id, dim: selId && !onPath(n) }" @click="pick(n)">
              <rect :x="n.x" :y="n.y" :width="NODE_W" :height="n.h" :fill="n.color" rx="2" />
              <text v-if="n.h >= 9 || selId === n.id" :x="n.x + NODE_W + 5" :y="n.y + Math.min(n.h / 2, 12) + 4" class="lab">
                {{ n.label }} <tspan class="pct">{{ fmtPct(n.value, n.value < 0.1 ? 1 : 0) }}</tspan>
              </text>
              <title>{{ n.full }}: {{ fmtPct(n.value, 1) }} of the exit light</title>
            </g>
          </g>
        </svg>
      </div>
      <p class="muted small">
        A band that goes straight from the LED to the exit does not meet any of your surfaces. Hover a band or a surface for its share; small ones are not labelled.
        Covers {{ fmtPct(data.covered, 0) }} of the exit light (the biggest routes). Routes that meet more than {{ MAX_STEPS }} surfaces are drawn by their first {{ MAX_STEPS }}.
        The exit surface is cut in {{ data.bands }} parts along the <strong :style="{ color: data.along === 'u' ? '#dc2626' : '#16a34a' }">{{ data.along === "u" ? "red (u)" : "green (v)" }}</strong> arrow of the maps.
      </p>

      <div v-if="selNode && selNode.kind !== 'led'" class="ana-detail">
        <div class="ana-detail-head">
          <strong><i class="swatch" :style="{ background: selNode.color }" /> {{ selNode.full }}</strong>
          <span class="muted small">{{ fmtPct(selNode.value, 1) }} of the exit light goes through here</span>
          <span class="spacer" />
          <button class="btn primary small" title="See the light that goes through here in the 3D model" @click="view3d"><Box :size="14" /> View in 3D</button>
        </div>
      </div>
    </template>
    <p v-else-if="!loading && !error" class="muted small">No routes were logged for this run.</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Box } from "lucide-vue-next";
import { api, type FlowDiagram } from "../../api";
import { injectAnalysisView, type AnalysisCtx } from "../../composables/useAnalysisView";
import { splitName } from "../../utils/analysisText";
import { fmtPct } from "../../utils/colormap";

const props = defineProps<{ ctx: AnalysisCtx }>();
const av = injectAnalysisView();

const MAX_STEPS = 4;
const NODE_W = 14;
const W = 980;
const H = 380;
const GAP = 9;
const BANDS = 4;

const data = ref<FlowDiagram | null>(null);
const loading = ref(false);
const error = ref("");
const selId = ref<string | null>(null);

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const r = await api.analysisFlow(props.ctx.runId, { state: props.ctx.state, view: props.ctx.view, detector: props.ctx.detector, bands: BANDS });
    if (mine !== seq) return;
    data.value = r;
    error.value = "";
    selId.value = null;
  } catch (e) {
    if (mine === seq) {
      data.value = null;
      error.value = (e as Error).message;
    }
  } finally {
    if (mine === seq) loading.value = false;
  }
}
watch(() => [props.ctx.runId, props.ctx.state, props.ctx.view, props.ctx.detector], load, { immediate: true });

interface FNode {
  id: string;
  kind: "led" | "surface" | "exit";
  col: number;
  label: string;
  full: string;
  color: string;
  value: number;
  group?: number;
  band?: number;
  fams: Set<string>;
  x: number;
  y: number;
  h: number;
  out: FLink[];
  inn: FLink[];
}
interface FLink {
  id: string;
  src: FNode;
  dst: FNode;
  value: number;
  fams: Set<string>;
  sy: number;
  dy: number;
  h: number;
  color: string;
  d: string;
}

const short = (s: string, n = 24) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ordinal = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th"];

const layout = computed(() => {
  const d = data.value;
  if (!d || !d.families.length) return null;
  const steps = Math.max(0, Math.min(MAX_STEPS, ...[Math.max(...d.families.map((f) => f.route.length))]));
  const exitCol = steps + 1;
  const ncols = exitCol + 1;
  const nodes = new Map<string, FNode>();
  const links = new Map<string, FLink>();

  const node = (id: string, init: Omit<FNode, "id" | "value" | "fams" | "x" | "y" | "h" | "out" | "inn">): FNode => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, ...init, value: 0, fams: new Set(), x: 0, y: 0, h: 0, out: [], inn: [] };
      nodes.set(id, n);
    }
    return n;
  };
  const link = (a: FNode, b: FNode, value: number, fam: string) => {
    if (value <= 0) return;
    const id = `${a.id}>${b.id}`;
    let l = links.get(id);
    if (!l) {
      l = { id, src: a, dst: b, value: 0, fams: new Set(), sy: 0, dy: 0, h: 0, color: b.kind === "surface" ? b.color : a.color, d: "" };
      links.set(id, l);
      a.out.push(l);
      b.inn.push(l);
    }
    l.value += value;
    l.fams.add(fam);
  };

  d.families.forEach((f, fi) => {
    const chain: FNode[] = [node(`led:${f.led}`, { kind: "led", col: 0, label: f.ledName, full: f.ledName, color: "#ca8a04" })];
    f.route.slice(0, steps).forEach((g, i) => {
      const gi = av.groups.value.find((x) => x.index === g);
      const nm = splitName(gi?.name ?? `surface ${g}`);
      chain.push(
        node(`s${i + 1}:${g}`, {
          kind: "surface", col: i + 1, label: short(nm.face ? `${nm.part} · ${nm.face.replace("face ", "f")}` : nm.part), full: gi?.name ?? `surface ${g}`, color: f.colors[i] ?? av.groupCss(g), group: g,
        }),
      );
    });
    chain.forEach((n) => {
      n.value += f.fraction;
      n.fams.add(f.id);
    });
    for (let i = 0; i + 1 < chain.length; i++) link(chain[i], chain[i + 1], f.fraction, f.id);
    d.matrix[fi].forEach((v, b) => {
      const ex = node(`exit:${b}`, {
        kind: "exit", col: exitCol, label: `Exit, part ${b + 1}/${d.bands}`, full: `${ordinal[b] ?? b + 1} of ${d.bands} parts of the exit surface`, color: "#16a34a", band: b,
      });
      if (v > 0) {
        ex.value += v;
        ex.fams.add(f.id);
        link(chain[chain.length - 1], ex, v, f.id);
      }
    });
  });
  // exit parts with no light still exist as places (keeps the column honest)
  for (let b = 0; b < d.bands; b++)
    node(`exit:${b}`, { kind: "exit", col: exitCol, label: `Exit, part ${b + 1}/${d.bands}`, full: `${ordinal[b] ?? b + 1} of ${d.bands} parts of the exit surface`, color: "#16a34a", band: b });

  const cols: FNode[][] = Array.from({ length: ncols }, () => []);
  for (const n of nodes.values()) cols[n.col].push(n);
  cols.forEach((c, ci) => (ci === exitCol ? c.sort((a, b) => (a.band ?? 0) - (b.band ?? 0)) : c.sort((a, b) => b.value - a.value)));

  // one scale for every column, so a band means the same share everywhere
  let k = Infinity;
  for (const c of cols) {
    const tot = c.reduce((s, n) => s + n.value, 0) || 1;
    k = Math.min(k, (H - GAP * Math.max(0, c.length - 1)) / tot);
  }
  const labelRoom = 150;
  const stepX = (W - NODE_W - labelRoom - 6) / Math.max(1, ncols - 1);
  cols.forEach((c, ci) => {
    const total = c.reduce((s, n) => s + Math.max(n.value * k, 3), 0) + GAP * Math.max(0, c.length - 1);
    let y = Math.max(0, (H - total) / 2);
    for (const n of c) {
      n.x = 4 + ci * stepX;
      n.h = Math.max(n.value * k, 3);
      n.y = y;
      y += n.h + GAP;
    }
  });
  // ribbons: leave and enter each node in the order of the nodes at the other end (fewer crossings)
  for (const n of nodes.values()) {
    n.out.sort((a, b) => a.dst.y - b.dst.y);
    n.inn.sort((a, b) => a.src.y - b.src.y);
  }
  for (const n of nodes.values()) {
    let o = n.y;
    for (const l of n.out) {
      l.h = Math.max(l.value * k, 1);
      l.sy = o + l.h / 2;
      o += l.h;
    }
    let i = n.y;
    for (const l of n.inn) {
      l.dy = i + l.h / 2;
      i += l.h;
    }
  }
  const all = [...links.values()];
  for (const l of all) {
    const x1 = l.src.x + NODE_W;
    const x2 = l.dst.x;
    const cx = (x1 + x2) / 2;
    l.d = `M${x1},${l.sy} C${cx},${l.sy} ${cx},${l.dy} ${x2},${l.dy}`;
  }
  const heads = cols.map((_, ci) => ({
    x: 4 + ci * stepX,
    text: ci === 0 ? "LED" : ci === exitCol ? "Lands on the exit surface" : `${ordinal[ci - 1]} surface it meets`,
  }));
  return { nodes: [...nodes.values()], links: all, heads, height: H + 26 };
});

const selNode = computed(() => layout.value?.nodes.find((n) => n.id === selId.value) ?? null);
const onPath = (n: FNode) => !selNode.value || [...selNode.value.fams].some((f) => n.fams.has(f));
function linkOpacity(l: FLink) {
  if (!selNode.value) return 0.38;
  return [...selNode.value.fams].some((f) => l.fams.has(f)) ? 0.62 : 0.07;
}
function pick(n: FNode) {
  selId.value = selId.value === n.id ? null : n.id;
}

/** See the light that goes through the picked surface, or lands in the picked part of the exit surface, in 3D. */
function view3d() {
  const n = selNode.value;
  const d = data.value;
  if (!n || !d) return;
  if (n.kind === "surface" && n.group !== undefined) {
    const gi = av.groups.value.find((x) => x.index === n.group);
    if (!gi) return;
    av.viewSelection({
      id: `flow:surface:${n.group}:${props.ctx.detector}`,
      kind: "surface",
      label: gi.name,
      spots: [{ label: gi.name, color: gi.color, faces: gi.faces.map((f) => ({ instance: f.instance, face: f.face })) }],
      footprint: { kind: "group", id: n.group, mode: "touched", detector: props.ctx.detector, vmax: props.ctx.vmax },
      rays: { filter: { touched: n.group, outcome: "exit" }, label: `Touched “${n.full}”, reached the exit`, color: "group" },
      showRays: true,
    });
  } else if (n.kind === "exit" && n.band !== undefined) {
    const a = n.band / d.bands;
    const b = (n.band + 1) / d.bands;
    const polygon = d.along === "u" ? [[a, 0], [b, 0], [b, 1], [a, 1]] : [[0, a], [1, a], [1, b], [0, b]];
    av.viewSelection({
      id: `flow:exit:${n.band}:${props.ctx.detector}`,
      kind: "region",
      label: `Lands in ${n.full}`,
      spots: [],
      footprint: null,
      rays: { filter: { region: { detector: props.ctx.detector, polygon }, outcome: "exit" }, label: `Lands in ${n.full}`, color: "group" },
      showRays: true,
    });
  }
}</script>

<style scoped>
.ana-tab { display: flex; flex-direction: column; gap: 8px; }
.flow-wrap { border: 1px solid var(--neutral-3); border-radius: var(--radius-md); background: var(--neutral-1); padding: 6px; overflow-x: auto; }
.flow { width: 100%; min-width: 640px; height: auto; display: block; }
.head { font-size: 11px; fill: var(--neutral-9); font-weight: 600; }
.link { cursor: pointer; transition: opacity 120ms; }
.link:hover { opacity: 0.8 !important; }
.node { cursor: pointer; }
.node.dim { opacity: 0.35; }
.node.sel rect { stroke: var(--neutral-12); stroke-width: 2; }
.lab { font-size: 11.5px; fill: var(--neutral-12); paint-order: stroke; stroke: var(--neutral-1); stroke-width: 3px; stroke-linejoin: round; }
.pct { fill: var(--neutral-10); font-weight: 600; }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; flex: none; }
.ana-detail { display: flex; flex-direction: column; gap: 8px; border-top: 1px dashed var(--neutral-4); padding-top: 8px; }
.ana-detail-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
