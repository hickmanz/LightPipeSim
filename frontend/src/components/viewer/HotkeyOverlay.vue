<template>
  <Transition name="hotkey-overlay-fade">
    <div v-if="visible && grouped.length > 0" class="hotkey-overlay">
      <div v-for="group in grouped" :key="group.category" class="hotkey-group">
        <div class="hotkey-group-label">{{ group.category }}</div>
        <div v-for="item in group.items" :key="item.id" class="hotkey-row">
          <kbd :class="{ 'hotkey-mouse': item.displayOnly }">{{
            formatKeys(item.keys)
          }}</kbd>
          <span class="hotkey-label">{{ item.label }}</span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { HotkeyDefinition } from "../../composables/viewer/useHotkeys";

const props = defineProps<{
  hotkeys: HotkeyDefinition[];
  visible: boolean;
}>();

interface HotkeyGroup {
  category: string;
  items: HotkeyDefinition[];
}

const grouped = computed<HotkeyGroup[]>(() => {
  const map = new Map<string, HotkeyDefinition[]>();
  for (const hk of props.hotkeys) {
    const list = map.get(hk.category) ?? [];
    list.push(hk);
    map.set(hk.category, list);
  }
  return [...map.entries()].map(([category, items]) => ({ category, items }));
});

function formatKeys(keys: string): string {
  return keys
    .split("+")
    .map((p) => {
      const t = p.trim();
      if (t.toLowerCase() === "ctrl" || t.toLowerCase() === "mod")
        return "Ctrl";
      if (t.toLowerCase() === "meta") return "⌘";
      if (t.toLowerCase() === "shift") return "Shift";
      if (t.toLowerCase() === "alt") return "Alt";
      if (t.toLowerCase() === "escape") return "Esc";
      if (t.length === 1) return t.toUpperCase();
      return t;
    })
    .join(" + ");
}
</script>

<style scoped>
.hotkey-overlay {
  position: absolute;
  bottom: 16px;
  left: 16px;
  border-radius: 8px;
  padding: 10px 14px;
  pointer-events: none;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 140px;
  max-width: 220px;
}

.hotkey-group-label {
  font-size: 0.65rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-con-low);
  margin-bottom: 2px;
}

.hotkey-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.82rem;
  color: var(--vp-con-low);
  line-height: 1;
  padding: var(--spacing-xs) 0;
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--vp-con-high) 30%, transparent);
  color: var(--vp-con-low);
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  white-space: nowrap;
}

.hotkey-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.hotkey-group + .hotkey-group {
  border-top: 1px solid var(--vp-con-low);
  padding-top: 8px;
}

/* Transition */
.hotkey-overlay-fade-enter-active,
.hotkey-overlay-fade-leave-active {
  transition: opacity 0.2s ease;
}
.hotkey-overlay-fade-enter-from,
.hotkey-overlay-fade-leave-to {
  opacity: 0;
}
</style>
