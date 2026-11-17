<template>
  <button ref="btnRef" class="tbtn" :class="{ on: open }" :title="title" :aria-label="title" :disabled="disabled" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
    <slot />
    <ChevronDown :size="12" class="tbtn-caret" />
  </button>
  <ContextMenu :visible="open" :items="items" :x="x" :y="y" @pick="(id) => $emit('pick', id)" @close="close" />
</template>

<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown } from "lucide-vue-next";
import ContextMenu, { type MenuItem } from "./ContextMenu.vue";

defineProps<{ items: MenuItem[]; title: string; disabled?: boolean }>();
defineEmits<{ pick: [id: string] }>();

const btnRef = ref<HTMLElement | null>(null);
const open = ref(false);
const x = ref(0);
const y = ref(0);

let closedAt = 0;
function close() {
  open.value = false;
  closedAt = Date.now();
}
function toggle() {
  // the outside-mousedown that closes the menu is followed by this click: don't reopen
  if (open.value || Date.now() - closedAt < 250) return close();
  const r = btnRef.value?.getBoundingClientRect();
  if (r) {
    x.value = r.left;
    y.value = r.bottom + 4;
  }
  open.value = true;
}
</script>
