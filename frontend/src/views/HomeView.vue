<template>
  <div class="home">
    <header class="home-head">
      <div class="brand"><Lightbulb :size="26" /> <span>LightSim</span></div>
      <div class="spacer" />
      <button class="icon-btn" title="Settings: data folder" @click="settingsOpen = true"><Settings :size="18" /></button>
      <button class="icon-btn" title="Toggle light/dark" @click="toggleTheme"><component :is="isDark ? Sun : Moon" :size="18" /></button>
    </header>

    <main class="home-main">
      <section
        class="dropzone"
        :class="{ over: dragOver, busy: uploading }"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
        @click="fileInput?.click()"
      >
        <input ref="fileInput" type="file" accept=".step,.stp,.STEP,.STP" hidden @change="onPick" />
        <div v-if="uploading" class="spinner" />
        <Upload v-else :size="36" />
        <h2>{{ uploading ? "Uploading…" : "Drop a STEP file here" }}</h2>
        <p class="muted">a new design, or a new revision of an existing one. Everything stays on this computer.</p>
      </section>

      <p v-if="error" class="notice warn"><AlertTriangle :size="15" /> {{ error }}</p>

      <section v-if="projects.length" class="recent">
        <h3>Projects</h3>
        <ul>
          <li v-for="p in projects" :key="p.id" class="model-row" @click="open(p)">
            <FileBox :size="22" class="model-icon" />
            <div class="model-info">
              <div class="model-name">{{ p.name }}</div>
              <div class="muted small">
                {{ p.variants.length > 1 ? `${p.variants.length} variants · ` : "" }}{{ p.revisions.length }} revision{{ p.revisions.length === 1 ? "" : "s" }} · opened {{ fmtAgo(p.lastOpened) }}
              </div>
              <div v-if="p.latest && active(p.latest)" class="progress thin">
                <div class="progress-bar" :style="{ width: Math.round(p.latest.progress.fraction * 100) + '%' }" />
              </div>
              <div v-if="p.latest && active(p.latest)" class="muted small">{{ p.latest.progress.phase }}</div>
              <div v-if="p.latest?.status === 'failed'" class="error small">{{ p.latest.error }}</div>
            </div>
            <span v-if="p.latest" class="chip" :class="p.latest.status">{{ statusText[p.latest.status] }}</span>
            <button v-if="p.latest && active(p.latest)" class="icon-btn" title="Cancel" @click.stop="cancel(p.latest)"><X :size="16" /></button>
            <template v-else>
              <button class="icon-btn" title="Rename" @click.stop="rename(p)"><Pencil :size="15" /></button>
              <button class="icon-btn" title="Delete project" @click.stop="remove(p)"><Trash2 :size="16" /></button>
            </template>
          </li>
        </ul>
      </section>
      <p v-else-if="!loading" class="muted center">No projects yet. Drop a STEP file above to get started.</p>
    </main>

    <SettingsDialog v-if="settingsOpen" @close="settingsOpen = false" @changed="refresh" />

    <!-- which project does this file belong to? -->
    <div v-if="pendingFile" class="modal-backdrop" @click.self="pendingFile = null">
      <form class="modal" @submit.prevent="confirmUpload">
        <h3>Add {{ pendingFile.name }}</h3>
        <p class="muted small">
          A project holds variants (design alternatives such as another LED spacing or reflector). A variant has its own optical setup (materials, LEDs,
          exit surface); its revisions are successive edits of that design. Runs of all variants can be compared.
        </p>
        <label v-for="p in projects" :key="p.id" class="choice">
          <input v-model="choice" type="radio" :value="p.id" />
          <span>Add to <strong>{{ p.name }}</strong> <em class="muted small">({{ p.revisions.length }} revision{{ p.revisions.length === 1 ? "" : "s" }}, {{ p.variants.length }} variant{{ p.variants.length === 1 ? "" : "s" }})</em></span>
        </label>
        <label class="choice">
          <input v-model="choice" type="radio" value="new" />
          <span>New project</span>
        </label>
        <input v-if="choice === 'new'" v-model="newName" class="text-input" placeholder="Project name" />
        <template v-if="chosenProject">
          <label class="choice">
            <span class="muted small">Which design is this?</span>
          </label>
          <select v-model="variantChoice" class="text-input">
            <option v-for="v in chosenProject.variants" :key="v.id" :value="v.id">A new revision of the variant “{{ v.name }}”</option>
            <option value="new">A new variant (design alternative)</option>
          </select>
          <template v-if="variantChoice === 'new'">
            <input v-model="variantName" class="text-input" placeholder="Variant name, e.g. LED pitch 8 mm" />
            <label class="choice">
              <span class="muted small">Start from the setup of</span>
              <select v-model="copyFrom" class="text-input">
                <option value="">an empty setup (use Auto-setup)</option>
                <option v-for="v in chosenProject.variants" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
            </label>
          </template>
        </template>
        <div class="modal-actions">
          <button type="button" class="btn" @click="pendingFile = null">Cancel</button>
          <button type="submit" class="btn primary" :disabled="uploading">Upload</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { AlertTriangle, FileBox, Lightbulb, Moon, Pencil, Settings, Sun, Trash2, Upload, X } from "lucide-vue-next";
import { api, type Project, type RevisionMeta } from "../api";
import SettingsDialog from "../components/SettingsDialog.vue";
import { isDark, toggleTheme } from "../composables/useTheme";
import { fmtAgo } from "../utils/format";

const router = useRouter();
const projects = ref<Project[]>([]);
const loading = ref(true);
const error = ref("");
const uploading = ref(false);
const dragOver = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const pendingFile = ref<File | null>(null);
const choice = ref("new");
const newName = ref("");
const settingsOpen = ref(false);
const variantChoice = ref(""); // a variant id of the chosen project, or "new"
const variantName = ref("");
const copyFrom = ref("");
const chosenProject = computed(() => (choice.value === "new" ? null : (projects.value.find((p) => p.id === choice.value) ?? null)));
// pick the variant that was worked on last whenever another project is chosen
watch(
  chosenProject,
  (p) => {
    variantChoice.value = p ? (p.latest?.variantId ?? p.variants[0]?.id ?? "") : "";
    copyFrom.value = variantChoice.value;
    variantName.value = "";
  },
  { immediate: true },
);

const statusText: Record<string, string> = { queued: "Queued", running: "Processing", ready: "Ready", failed: "Failed", cancelled: "Cancelled" };
const active = (m: RevisionMeta) => m.status === "queued" || m.status === "running";
const anyActive = computed(() => projects.value.some((p) => p.latest && active(p.latest)));

let timer: number | undefined;
async function refresh() {
  try {
    projects.value = await api.listProjects();
    error.value = "";
  } catch (e) {
    error.value = `Cannot reach the local server: ${(e as Error).message}`;
  } finally {
    loading.value = false;
  }
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, anyActive.value ? 1000 : document.hidden ? 15000 : 5000);
}

function stage(file: File) {
  error.value = "";
  if (!/\.(step|stp)$/i.test(file.name)) {
    error.value = "Please choose a .step or .stp file.";
    return;
  }
  const stem = file.name.replace(/\.[^.]+$/, "");
  const match = projects.value.find((p) => p.stem === stem.toLowerCase());
  newName.value = stem;
  pendingFile.value = file;
  choice.value = match?.id ?? "new";
  if (!projects.value.length) void confirmUpload();
}

async function confirmUpload() {
  const file = pendingFile.value;
  if (!file) return;
  uploading.value = true;
  try {
    const target =
      choice.value === "new"
        ? { projectId: "new", projectName: newName.value }
        : variantChoice.value === "new"
          ? { projectId: choice.value, variantId: "new", variantName: variantName.value.trim(), copySetupFrom: copyFrom.value || undefined }
          : { projectId: choice.value, variantId: variantChoice.value || undefined };
    const res = await api.upload(file, target);
    const adapt = choice.value !== "new" && variantChoice.value === "new" && !!copyFrom.value; // a copied setup is adapted to the new geometry
    pendingFile.value = null;
    router.push(adapt ? { path: `/r/${res.id}`, query: { adapt: "1" } } : `/r/${res.id}`);
  } catch (e) {
    error.value = (e as Error).message;
    pendingFile.value = null;
  } finally {
    uploading.value = false;
  }
}
function onDrop(e: DragEvent) {
  dragOver.value = false;
  const f = e.dataTransfer?.files?.[0];
  if (f) stage(f);
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0];
  input.value = "";
  if (f) stage(f);
}
function open(p: Project) {
  router.push(`/p/${p.id}`);
}
async function attempt(fn: () => Promise<unknown>) {
  error.value = "";
  try {
    await fn();
  } catch (e) {
    error.value = (e as Error).message;
  }
  refresh();
}
function cancel(m: RevisionMeta) {
  return attempt(() => api.cancelImport(m.id));
}
async function rename(p: Project) {
  const name = window.prompt("Rename project", p.name);
  if (name && name.trim()) await attempt(() => api.renameProject(p.id, name.trim()));
}
async function remove(p: Project) {
  if (!confirm(`Delete project "${p.name}" with all ${p.revisions.length} revision(s), the setup and every simulation run?`)) return;
  await attempt(() => api.deleteProject(p.id));
}

onMounted(refresh);
onBeforeUnmount(() => window.clearTimeout(timer));
</script>
