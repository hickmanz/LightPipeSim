<template>
  <div class="tab-body">
    <section class="run-box">
      <h4>Simulate this revision</h4>
      <div v-if="ws.checkError.value" class="notice warn"><AlertTriangle :size="15" /><span>{{ ws.checkError.value }}</span></div>
      <template v-else-if="ws.check.value">
        <p class="small muted">
          {{ ws.check.value.channels.length }} source channel{{ ws.check.value.channels.length === 1 ? "" : "s" }} ·
          {{ ws.check.value.detectors.length }} exit surface{{ ws.check.value.detectors.length === 1 ? "" : "s" }} ·
          {{ ws.check.value.triangles.toLocaleString() }} triangles
        </p>
        <CheckWarnings />
      </template>
      <p v-else class="muted small">Checking the setup…</p>

      <label class="mini">
        <span>Rays per source channel</span>
        <select v-model.number="rays">
          <option v-for="r in rayOptions" :key="r" :value="r">{{ r.toLocaleString() }}{{ r === 200000 ? " (quick look)" : r === 2000000 ? " (smooth)" : "" }}</option>
        </select>
      </label>
      <p class="muted small">
        About {{ estimate }} for {{ channelCount }} channel{{ channelCount === 1 ? "" : "s" }}. Use more rays for smooth colour maps and hotspot counts.
      </p>
      <label class="mini">
        <span>Name (optional)</span>
        <input v-model="name" class="text-input" placeholder="e.g. 0.05 % TiO2, texture fine" />
      </label>
      <button class="btn primary" :disabled="!ws.check.value || busy" @click="start"><Play :size="15" /> Run simulation</button>
      <p v-if="error" class="error small">{{ error }}</p>
    </section>

    <section class="run-box">
      <h4>Runs of this revision</h4>
      <p v-if="!plainRuns.length" class="muted small">No runs yet.</p>
      <ul class="run-list">
        <li v-for="r in plainRuns" :key="r.id" class="run-item" :class="{ selected: r.id === activeRun }" @click="r.status === 'ready' && $emit('open', r.id)">
          <div class="run-head">
            <span class="run-name">{{ r.name }}</span>
            <span class="chip" :class="r.status">{{ statusText[r.status] }}</span>
            <button v-if="r.status === 'queued' || r.status === 'running'" class="icon-btn" title="Cancel" @click.stop="cancel(r)"><X :size="14" /></button>
            <template v-else>
              <button class="icon-btn" title="Rename" @click.stop="rename(r)"><Pencil :size="13" /></button>
              <button class="icon-btn" title="Delete run" @click.stop="remove(r)"><Trash2 :size="14" /></button>
            </template>
          </div>
          <div v-if="r.status === 'running' || r.status === 'queued'" class="progress thin"><div class="progress-bar" :style="{ width: Math.round(r.progress.fraction * 100) + '%' }" /></div>
          <div v-if="r.status === 'running'" class="muted small">{{ r.progress.phase }}</div>
          <div v-else-if="r.status === 'failed'" class="error small">{{ r.error }}</div>
          <div v-else-if="r.status === 'ready' && r.summary?.states?.length" class="muted small">
            {{ fmtAgo(r.created) }} · {{ r.settings.rays.toLocaleString() }} rays ·
            efficiency {{ fmtPct(r.summary.states[0].detectors[0]?.efficiency) }} ·
            {{ r.timing?.seconds }} s
          </div>
          <div v-else class="muted small">{{ fmtAgo(r.created) }}</div>
        </li>
      </ul>
    </section>

    <SweepPanel @open="(id) => emit('open', id)" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertTriangle, Pencil, Play, Trash2, X } from "lucide-vue-next";
import { api, type RunMeta } from "../api";
import { useWorkspace } from "../composables/useWorkspace";
import { fmtPct } from "../utils/colormap";
import { fmtAgo } from "../utils/format";
import CheckWarnings from "./CheckWarnings.vue";
import SweepPanel from "./SweepPanel.vue";

defineProps<{ activeRun: string | null }>();
const emit = defineEmits<{ open: [id: string]; started: [id: string] }>();

const ws = useWorkspace();
const rays = ref(200000);
const rayOptions = [50000, 200000, 500000, 1000000, 2000000, 5000000];
const name = ref("");
const busy = ref(false);
const error = ref("");
const statusText: Record<string, string> = { queued: "Queued", running: "Running", ready: "Done", failed: "Failed", cancelled: "Cancelled" };

const plainRuns = computed(() => ws.runs.value.filter((r) => !r.sweep));
const channelCount = computed(() => ws.check.value?.channels.length ?? 0);
const estimate = computed(() => {
  const s = (rays.value * Math.max(channelCount.value, 1)) / 140000;
  return s < 90 ? `${Math.max(1, Math.round(s))} s` : `${(s / 60).toFixed(1)} min`;
});

async function start() {
  busy.value = true;
  error.value = "";
  try {
    await ws.saveNow();
    const run = await api.createRun(ws.rid.value, { name: name.value, settings: { rays: rays.value } });
    name.value = "";
    await ws.loadRuns();
    emit("started", run.id);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function cancel(r: RunMeta) {
  await api.cancelRun(r.id);
  await ws.loadRuns();
}
async function rename(r: RunMeta) {
  const n = window.prompt("Rename run", r.name);
  if (n && n.trim()) {
    await api.renameRun(r.id, n.trim());
    await ws.loadRuns();
  }
}
async function remove(r: RunMeta) {
  if (!confirm(`Delete run "${r.name}" and its results?`)) return;
  await api.deleteRun(r.id);
  await ws.loadRuns();
}
</script>
