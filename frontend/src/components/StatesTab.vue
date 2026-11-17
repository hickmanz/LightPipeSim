<template>
  <div class="tab-body">
    <p class="muted small">
      A <strong>state</strong> sets how hard each LED channel is driven (0 – 1). Every channel is simulated once, so states cost nothing extra: use them for
      colour mixing (R, G, B levels), single-LED checks, or a dimmed version.
    </p>

    <div v-for="st in states" :key="st.id" class="state-card">
      <div class="led-head">
        <input v-model="st.name" class="text-input name" />
        <button class="icon-btn" title="Remove" @click="remove(st.id)"><Trash2 :size="14" /></button>
      </div>
      <button
        v-if="channels.length"
        class="face-toggle"
        :aria-expanded="isOpen(st)"
        :title="isOpen(st) ? 'Hide the channels of this state' : 'Show the channels of this state'"
        @click="toggleOpen(st)"
      >
        <ChevronRight :size="14" class="chev" :class="{ open: isOpen(st) }" />
        <span class="small">{{ channels.length }} channel{{ channels.length === 1 ? "" : "s" }}</span>
        <span v-if="!isOpen(st)" class="muted small summary">{{ summary(st) }}</span>
      </button>
      <table v-if="isOpen(st)" class="drive-table">
        <thead>
          <tr><th>LED / channel</th><th>Drive</th></tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.key">
            <td class="small" :title="ch.key">{{ ch.label }}</td>
            <td>
              <input :value="driveOf(st, ch.key)" type="number" min="0" max="2" step="0.05" @change="setDrive(st, ch.key, Number(($event.target as HTMLInputElement).value))" />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="tab-actions">
        <button class="btn small" @click="setAll(st, 1)">All 1</button>
        <button class="btn small" @click="setAll(st, 0)">All 0</button>
      </div>
    </div>
    <p v-if="!states.length" class="muted center small">No states yet: a single “all LEDs on” state is used when none is defined.</p>
    <div class="tab-actions">
      <button class="btn small" @click="add"><Plus :size="14" /> Add state</button>
      <button class="btn small" @click="generate"><Wand2 :size="14" /> All on + one per LED</button>
      <button v-if="states.length > 1 && channels.length" class="btn small" :title="allOpen ? 'Hide the channels of all states' : 'Show the channels of all states'" @click="setAllOpen(!allOpen)">
        <ChevronsUpDown :size="14" /> {{ allOpen ? "Collapse all" : "Expand all" }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from "vue";
import { ChevronRight, ChevronsUpDown, Plus, Trash2, Wand2 } from "lucide-vue-next";
import type { StateDef } from "../api";
import { useWorkspace } from "../composables/useWorkspace";
import { ledChannelKeys, newId } from "../utils/setup";

const ws = useWorkspace();
const states = computed(() => ws.setup.value?.states ?? []);
const channels = computed(() => {
  if (!ws.setup.value || !ws.library.value) return [];
  return ws.setup.value.leds.filter((l) => l.enabled !== false).flatMap((l) => ledChannelKeys(l, ws.library.value!));
});

// the channel table of a state folds away; with up to 4 channels it starts open, with more it starts folded
const open = reactive<Record<string, boolean>>({});
const isOpen = (st: StateDef) => open[st.id] ?? channels.value.length <= 4;
const toggleOpen = (st: StateDef) => (open[st.id] = !isOpen(st));
const allOpen = computed(() => states.value.every((st) => isOpen(st)));
const setAllOpen = (on: boolean) => states.value.forEach((st) => (open[st.id] = on));
/** One line for a folded state: which channels are driven. */
function summary(st: StateDef): string {
  const on = channels.value.filter((c) => driveOf(st, c.key) > 0);
  if (!on.length) return "all off";
  if (on.length === channels.value.length) return channels.value.every((c) => driveOf(st, c.key) === 1) ? "all on" : "all driven";
  return on.length <= 2 ? on.map((c) => c.label).join(", ") : `${on.length} of ${channels.value.length} on`;
}

/** The drive of a channel in a state (explicit key, then `led/*`, then `*`). */
function driveOf(st: StateDef, key: string): number {
  const [led] = key.split("/");
  if (key in st.drive) return st.drive[key];
  if (`${led}/*` in st.drive) return st.drive[`${led}/*`];
  if ("*/*" in st.drive) return st.drive["*/*"];
  if ("*" in st.drive) return st.drive["*"];
  return 0;
}
/** Convert wildcards to explicit keys once the user edits a drive, so the table is the truth. */
function explicit(st: StateDef) {
  const next: Record<string, number> = {};
  for (const ch of channels.value) next[ch.key] = driveOf(st, ch.key);
  st.drive = next;
}
function setDrive(st: StateDef, key: string, v: number) {
  ws.mutate(() => {
    explicit(st);
    st.drive[key] = Math.max(0, v);
  });
}
function setAll(st: StateDef, v: number) {
  ws.mutate(() => {
    st.drive = Object.fromEntries(channels.value.map((c) => [c.key, v]));
  });
}
function add() {
  ws.mutate((s) => {
    const id = newId("state", s.states.map((x) => x.id));
    s.states.push({ id, name: `State ${s.states.length + 1}`, drive: Object.fromEntries(channels.value.map((c) => [c.key, 1])) });
  });
}
function remove(id: string) {
  ws.mutate((s) => {
    s.states = s.states.filter((x) => x.id !== id);
  });
}
function generate() {
  ws.mutate((s) => {
    const next: StateDef[] = [{ id: "all", name: "All LEDs on", drive: { "*": 1 } }];
    for (const l of s.leds.filter((x) => x.enabled !== false)) next.push({ id: `only_${l.id}`, name: `${l.name} only`, drive: { [`${l.id}/*`]: 1 } });
    s.states = next;
  });
}
</script>
