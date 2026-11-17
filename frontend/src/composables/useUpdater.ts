import { ref } from "vue";
import { api, type UpdateCheck, type UpdateStatus } from "../api";

/** Shared by the update banner (start page) and the Settings dialog, so both show the same state. */
export const updateCheck = ref<UpdateCheck | null>(null);
export const updateChecking = ref(false);
export const updateError = ref("");
export const updateProgress = ref<UpdateStatus | null>(null);
export const updateInstalling = ref(false);
export const updateDismissed = ref(false);

let startupDone = false;

export async function checkForUpdate(silent = false): Promise<UpdateCheck | null> {
  updateChecking.value = true;
  if (!silent) updateError.value = "";
  try {
    updateCheck.value = await api.checkUpdate();
    updateDismissed.value = false;
    return updateCheck.value;
  } catch (e) {
    if (!silent) updateError.value = (e as Error).message;
    return null;
  } finally {
    updateChecking.value = false;
  }
}

/** Once per app start, when the setting allows it. Failures are silent (offline is normal). */
export async function checkOnStartup(): Promise<void> {
  if (startupDone) return;
  startupDone = true;
  try {
    const cfg = await api.config();
    if (cfg.update.auto && (cfg.update.source === "github" || cfg.update.location)) await checkForUpdate(true);
  } catch {
    /* the server is not reachable yet: the start page shows that */
  }
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** Download the update found by the last check, then hand over to the installer (the app closes and restarts). */
export async function installUpdate(): Promise<void> {
  updateError.value = "";
  updateInstalling.value = true;
  try {
    let st = await api.downloadUpdate();
    updateProgress.value = st;
    while (st.state === "downloading") {
      await sleep(400);
      st = await api.updateStatus();
      updateProgress.value = st;
    }
    if (st.state === "failed") throw new Error(st.message || "The download failed.");
    const res = await api.installUpdate();
    if (!res.launched) {
      updateInstalling.value = false;
      updateError.value = res.message;
    }
    // launched: the installer replaces the app and starts it again; this window goes away
  } catch (e) {
    updateInstalling.value = false;
    updateProgress.value = null;
    updateError.value = (e as Error).message;
  }
}

export function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
}
