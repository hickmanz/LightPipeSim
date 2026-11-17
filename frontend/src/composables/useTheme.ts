import { ref } from "vue";
import * as radix from "@radix-ui/colors";

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "lightsim.theme";
export const themeMode = ref<ThemeMode>((localStorage.getItem(STORAGE_KEY) as ThemeMode) || "system");
export const isDark = ref(false);

function scale(name: string, dark: boolean): string[] {
  const table = radix as unknown as Record<string, Record<string, string>>;
  const obj = table[dark ? `${name}Dark` : name];
  return Array.from({ length: 12 }, (_, i) => obj[`${name}${i + 1}`]);
}

/** Writes the --accent-N / --neutral-N variables the Synapse viewer styles rely on. */
function applyScales(dark: boolean) {
  const el = document.documentElement;
  const accent = scale("sky", dark);
  const neutral = scale("slate", dark);
  for (let i = 0; i < 12; i++) {
    el.style.setProperty(`--accent-${i + 1}`, accent[i]);
    el.style.setProperty(`--neutral-${i + 1}`, neutral[i]);
  }
}

export function applyTheme() {
  const dark =
    themeMode.value === "dark" ||
    (themeMode.value === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  isDark.value = dark;
  applyScales(dark);
}

export function setThemeMode(mode: ThemeMode) {
  themeMode.value = mode;
  localStorage.setItem(STORAGE_KEY, mode);
  applyTheme();
}

export function toggleTheme() {
  setThemeMode(isDark.value ? "light" : "dark");
}

export function initTheme() {
  applyTheme();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (themeMode.value === "system") applyTheme();
  });
}
