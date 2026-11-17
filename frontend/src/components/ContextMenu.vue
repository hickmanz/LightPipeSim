<template>
  <Teleport to="body">
    <div v-if="visible" ref="menuRef" class="ctx-menu" :style="{ left: x + 'px', top: y + 'px' }" role="menu" @click.stop @contextmenu.prevent>
      <template v-for="(item, i) in items" :key="item.id">
        <div v-if="item.separator && i > 0" class="ctx-sep" role="separator" />
        <button class="ctx-item" :class="{ danger: item.danger }" role="menuitem" :disabled="item.disabled" @click="pick(item.id)">
          <component :is="item.icon" v-if="item.icon" :size="15" class="ctx-icon" />
          <span v-else class="ctx-icon" />
          <span class="ctx-label">{{ item.label }}</span>
          <kbd v-if="item.shortcut" class="ctx-kbd">{{ item.shortcut }}</kbd>
          <Check v-if="item.checked" :size="14" class="ctx-check" />
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script lang="ts">
import type { Component } from "vue";

export interface MenuItem {
  id: string;
  label: string;
  icon?: Component;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** show a tick (current choice in a list) */
  checked?: boolean;
  /** draw a divider above this item */
  separator?: boolean;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Check } from "lucide-vue-next";

const props = defineProps<{ visible: boolean; items: MenuItem[]; x: number; y: number }>();
const emit = defineEmits<{ pick: [id: string]; close: [] }>();

const menuRef = ref<HTMLElement | null>(null);

function pick(id: string) {
  emit("pick", id);
  emit("close");
}

/** Keep the menu on screen. */
async function fit() {
  await nextTick();
  const el = menuRef.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(props.x, window.innerWidth - r.width - 8));
  const top = Math.max(8, Math.min(props.y, window.innerHeight - r.height - 8));
  el.style.left = left + "px";
  el.style.top = top + "px";
}
watch(() => [props.visible, props.x, props.y], () => props.visible && fit());

function onDown(e: MouseEvent) {
  if (props.visible && menuRef.value && !menuRef.value.contains(e.target as Node)) emit("close");
}
function onKey(e: KeyboardEvent) {
  if (props.visible && e.key === "Escape") {
    e.stopPropagation();
    emit("close");
  }
}
onMounted(() => {
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", () => emit("close"));
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
});
</script>
