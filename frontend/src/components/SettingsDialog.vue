<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal wide">
      <h3>Settings</h3>

      <section class="settings-section">
        <h4>Data folder</h4>
        <p class="muted small">Projects, revisions, setups and simulation results are stored here.</p>
        <p v-if="cfg?.fromEnvironment" class="notice warn" style="margin: 6px 0">
          <AlertTriangle :size="15" />
          <span>The folder is fixed by the <code>LIGHTSIM_DATA</code> environment variable and cannot be changed here.</span>
        </p>
        <div class="folder-row">
          <input v-model="folder" type="text" placeholder="D:\LightSimData" :disabled="cfg?.fromEnvironment || busy" @keydown.enter="apply" />
          <button class="btn" :disabled="cfg?.fromEnvironment || busy" @click="browse"><FolderOpen :size="15" /> Browse…</button>
        </div>
        <label class="field row">
          <input v-model="copyExisting" type="checkbox" :disabled="cfg?.fromEnvironment || busy" />
          <span>Copy my current projects into the new folder</span>
        </label>
        <div class="modal-actions" style="justify-content: flex-start">
          <button class="btn primary" :disabled="!changed || busy || cfg?.fromEnvironment" @click="apply">Use this folder</button>
          <button v-if="cfg?.configuredDir" class="btn" :disabled="busy" @click="resetFolder">Back to default</button>
        </div>
        <p v-if="folderMsg" class="small" :class="folderOk ? 'ok-text' : 'error'">{{ folderMsg }}</p>
        <p class="muted small">Now using: <code>{{ cfg?.dataDir }}</code></p>
      </section>

      <hr class="modal-sep" />

      <section class="settings-section">
        <h4>This app</h4>
        <p class="muted small">LightSim version {{ cfg?.version }}.</p>
        <p v-if="cfg?.mode === 'window'" class="muted small">Close the window to quit the app.</p>
        <template v-else>
          <div class="modal-actions" style="justify-content: flex-start">
            <button class="btn" @click="quit"><Power :size="15" /> Quit the app</button>
          </div>
          <p v-if="quitMsg" class="muted small">{{ quitMsg }}</p>
        </template>
      </section>

      <div class="modal-actions">
        <button class="btn" @click="$emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { AlertTriangle, FolderOpen, Power } from "lucide-vue-next";
import { api, type AppConfig } from "../api";

const emit = defineEmits<{ close: []; changed: [] }>();

const cfg = ref<AppConfig | null>(null);
const folder = ref("");
const copyExisting = ref(true);
const busy = ref(false);
const folderMsg = ref("");
const folderOk = ref(false);
const quitMsg = ref("");

const changed = computed(() => !!cfg.value && folder.value.trim() !== "" && folder.value.trim() !== cfg.value.dataDir);

async function loadConfig() {
  cfg.value = await api.config();
  folder.value = cfg.value.dataDir;
}

async function browse() {
  folderMsg.value = "";
  busy.value = true;
  try {
    const res = await api.pickFolder(folder.value || undefined);
    if (res.path) folder.value = res.path;
    else if (res.error) {
      folderOk.value = false;
      folderMsg.value = `The folder dialog could not be opened (${res.error}). Type or paste the path instead.`;
    }
  } catch (e) {
    folderOk.value = false;
    folderMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

async function change(target: string, copy: boolean, okMessage: string) {
  busy.value = true;
  folderMsg.value = "";
  try {
    cfg.value = await api.setDataDir(target, copy);
    folder.value = cfg.value.dataDir;
    folderOk.value = true;
    folderMsg.value = cfg.value.copied ? `${okMessage} Copied ${cfg.value.copied} item(s).` : okMessage;
    emit("changed");
  } catch (e) {
    folderOk.value = false;
    folderMsg.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
const apply = () => (changed.value && !busy.value ? change(folder.value.trim(), copyExisting.value, "Now using this folder.") : undefined);
const resetFolder = () => change("", false, "Back to the default folder.");

async function quit() {
  if (!confirm("Quit LightSim? Running simulations will be cancelled.")) return;
  try {
    await api.quit();
  } catch {
    /* it is going away */
  }
  quitMsg.value = "The app has closed. You can close this tab.";
}

onMounted(loadConfig);
</script>

<style scoped>
.ok-text {
  color: var(--radix-green-9);
}
code {
  font-size: 0.78rem;
  word-break: break-all;
}
</style>
