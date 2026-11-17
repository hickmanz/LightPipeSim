<template>
  <div
    :class="['tree-node-wrapper', { 'tree-node-rolled-back': isRolledBack }]"
  >
    <div
      :class="['tree-node', { 'tree-node-selected': isSelected }]"
      :style="{ paddingLeft: `${level * 0.5}rem` }"
      :data-node-id="node.nodeId"
      @click="handleNodeClick"
      @contextmenu.prevent.stop="handleContextMenu"
    >
      <!-- Expand/collapse icon -->
      <span v-if="hasChildren" class="tree-expand-icon">
        <ChevronDown v-if="isExpanded" :size="14" />
        <ChevronRight v-else :size="14" />
      </span>
      <span v-else class="tree-expand-spacer"></span>

      <!-- Type icon -->
      <span class="tree-type-icon" :class="typeIconClass">
        <FileBox v-if="node.type === 'root'" :size="15" />
        <Boxes v-else-if="node.type === 'assembly'" :size="15" />
        <Box v-else :size="15" />
      </span>

      <!-- Visibility icon -->
      <span class="tree-visibility-icon" @click.stop="handleVisibilityClick">
        <Eye
          v-if="node.visibilityState === 'visible'"
          :size="16"
          class="tree-icon"
        />
        <EyeClosed
          v-else-if="node.visibilityState === 'hidden'"
          :size="16"
          class="tree-icon"
        />
        <EyeOff v-else :size="16" class="tree-icon" />
      </span>

      <!-- Node name -->
      <span class="tree-node-name" :title="fullName">{{ trimmedName }}</span>
    </div>

    <!-- Children with indent guide and expand/collapse transition -->
    <Transition name="tree-expand">
      <div
        v-if="hasChildren && isExpanded"
        class="tree-children"
        ref="childrenRef"
      >
        <template v-for="(child, index) in node.children" :key="child.nodeId">
          <!-- Rollback bar inserted before the first rolled-back child -->
          <div
            v-if="
              index === effectiveRollbackIndex &&
              effectiveRollbackIndex < node.children.length
            "
            class="rollback-bar"
            :class="{ 'rollback-bar-dragging': isDragging }"
            @mousedown.prevent="startDrag"
          >
            <div class="rollback-bar-line"></div>
            <div class="rollback-bar-handle">
              <GripHorizontal :size="12" />
            </div>
            <div class="rollback-bar-line"></div>
          </div>

          <TreeNode
            :node="child"
            :level="level + 1"
            :selected-node-ids="selectedNodeIds"
            :rollback-map="rollbackMap"
            :is-rolled-back="isRolledBack || index >= effectiveRollbackIndex"
            @node-click="$emit('node-click', $event)"
            @visibility-toggle="$emit('visibility-toggle', $event)"
            @node-contextmenu="
              (nodeId: number, x: number, y: number) =>
                $emit('node-contextmenu', nodeId, x, y)
            "
            @rollback-change="
              (nodeId: number, idx: number) =>
                $emit('rollback-change', nodeId, idx)
            "
          />
        </template>

        <!-- Rollback bar at the bottom when nothing is rolled back -->
        <div
          v-if="effectiveRollbackIndex >= node.children.length"
          class="rollback-bar"
          :class="{ 'rollback-bar-dragging': isDragging }"
          @mousedown.prevent="startDrag"
        >
          <div class="rollback-bar-line"></div>
          <div class="rollback-bar-handle">
            <GripHorizontal :size="12" />
          </div>
          <div class="rollback-bar-line"></div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from "vue";
import {
  Eye,
  EyeClosed,
  EyeOff,
  ChevronRight,
  ChevronDown,
  Box,
  Boxes,
  FileBox,
  GripHorizontal,
} from "lucide-vue-next";
import type { TreeNode } from "../../composables/viewer/useThreeViewer";

const props = withDefaults(
  defineProps<{
    node: TreeNode;
    level: number;
    selectedNodeIds: number[];
    rollbackMap?: Map<number, number>;
    isRolledBack?: boolean;
  }>(),
  {
    rollbackMap: () => new Map<number, number>(),
    isRolledBack: false,
  },
);

const emit = defineEmits<{
  "node-click": [nodeId: number];
  "visibility-toggle": [nodeId: number];
  "node-contextmenu": [nodeId: number, x: number, y: number];
  "rollback-change": [nodeId: number, index: number];
}>();

const isExpanded = ref(props.node.isExpanded);
const hasChildren = computed(() => props.node.children.length > 0);
const selectedSet = computed(() => new Set(props.selectedNodeIds));
const isSelected = computed(() => selectedSet.value.has(props.node.nodeId));
const fullName = computed(() => props.node.name || `Node ${props.node.nodeId}`);
const trimmedName = computed(() =>
  fullName.value.length > 12
    ? fullName.value.slice(0, 12) + "..."
    : fullName.value,
);

/** Recursively check if nodeId exists anywhere in a subtree. */
const subtreeContains = (node: TreeNode, targetId: number): boolean => {
  if (node.nodeId === targetId) return true;
  return node.children.some((c) => subtreeContains(c, targetId));
};

const typeIconClass = computed(() => {
  switch (props.node.type) {
    case "root":
      return "type-icon-root";
    case "assembly":
      return "type-icon-assembly";
    case "part":
      return "type-icon-part";
    default:
      return "";
  }
});

// --- Rollback bar state ---
const childrenRef = ref<HTMLElement | null>(null);
const isDragging = ref(false);
const dragIndex = ref<number | null>(null);

/** The rollback index from the map, or children.length if not set (all visible). */
const mapRollbackIndex = computed(() => {
  return props.rollbackMap.get(props.node.nodeId) ?? props.node.children.length;
});

/** During drag, use the live drag index; otherwise use the map value. */
const effectiveRollbackIndex = computed(() => {
  if (isDragging.value && dragIndex.value !== null) return dragIndex.value;
  return mapRollbackIndex.value;
});

// --- Drag handling ---
const startDrag = () => {
  if (props.isRolledBack) return; // Don't allow dragging on rolled-back parent
  isDragging.value = true;
  dragIndex.value = mapRollbackIndex.value;
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
  document.body.style.cursor = "ns-resize";
  document.body.style.userSelect = "none";
};

const onDragMove = (e: MouseEvent) => {
  if (!childrenRef.value) return;

  const cursorY = e.clientY;
  const childElements = childrenRef.value.querySelectorAll<HTMLElement>(
    ":scope > .tree-node-wrapper",
  );

  let newIndex = props.node.children.length; // default: bar at bottom (all visible)

  for (let i = 0; i < childElements.length; i++) {
    const rect = childElements[i].getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (cursorY < midY) {
      newIndex = i;
      break;
    }
  }

  // Clamp: allow index 0 (everything rolled back) through children.length (nothing rolled back)
  dragIndex.value = Math.max(0, Math.min(newIndex, props.node.children.length));
};

const onDragEnd = () => {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  document.body.style.cursor = "";
  document.body.style.userSelect = "";

  const finalIndex = dragIndex.value ?? props.node.children.length;
  isDragging.value = false;
  dragIndex.value = null;

  emit("rollback-change", props.node.nodeId, finalIndex);
};

// Clean up listeners if component unmounts during drag
onBeforeUnmount(() => {
  if (isDragging.value) {
    document.removeEventListener("mousemove", onDragMove);
    document.removeEventListener("mouseup", onDragEnd);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
});

// --- Existing behavior ---
watch(
  () => props.node.isExpanded,
  (newVal) => {
    isExpanded.value = newVal;
  },
);

// Auto-expand this node when any selected node is one of its descendants.
watch(
  () => props.selectedNodeIds,
  (ids) => {
    if (ids.length > 0 && hasChildren.value && !isExpanded.value) {
      const shouldExpand = ids.some(
        (id) => id !== props.node.nodeId && subtreeContains(props.node, id),
      );
      if (shouldExpand) isExpanded.value = true;
    }
  },
  { immediate: true },
);

const handleNodeClick = () => {
  if (hasChildren.value) {
    isExpanded.value = !isExpanded.value;
  }
  emit("node-click", props.node.nodeId);
};

const handleVisibilityClick = () => {
  emit("visibility-toggle", props.node.nodeId);
};

const handleContextMenu = (e: MouseEvent) => {
  emit("node-contextmenu", props.node.nodeId, e.clientX, e.clientY);
};
</script>

<style scoped>
.tree-node-wrapper {
  width: 100%;
}

.tree-node {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0.375rem 0.75rem;
  cursor: pointer;
  transition: background-color 120ms ease;
  user-select: none;
  min-height: 2rem;
  border-left: 3px solid transparent;
}

.tree-node:hover {
  background-color: var(--neutral-2);
}

.tree-node-selected {
  background-color: var(--accent-1);
  border-left-color: var(--accent-6);
  font-weight: 500;
}

.tree-node-selected:hover {
  background-color: var(--accent-2);
}

/* Rolled-back node styling */
.tree-node-rolled-back {
  opacity: 0.4;
  pointer-events: none;
}

.tree-node-rolled-back .tree-node {
  pointer-events: auto;
  cursor: default;
}

.tree-expand-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--neutral-6);
  flex-shrink: 0;
}

.tree-expand-spacer {
  width: 16px;
  flex-shrink: 0;
}

/* Type icons */
.tree-type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.type-icon-root {
  color: var(--neutral-6);
}

.type-icon-assembly {
  color: var(--accent-11); /* amber-600 */
}

.type-icon-part {
  color: var(--accent-9); /* sky-600 */
}

.tree-visibility-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--neutral-10);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition:
    background-color 120ms ease,
    color 120ms ease;
  flex-shrink: 0;
}

.tree-visibility-icon:hover {
  background-color: var(--neutral-2);
  color: var(--neutral-9);
}

.tree-icon {
  width: 16px;
  height: 16px;
}

.tree-node-name {
  flex: 1;
  font-size: 0.875rem;
  color: var(--neutral-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Indent guide: vertical line on the left of children */
.tree-children {
  width: 100%;
  margin-left: 0.625rem;
  border-left: 1px solid var(--neutral-3);
}

/* --- Rollback bar --- */
.rollback-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 2px 0.75rem;
  cursor: ns-resize;
  user-select: none;
  transition: opacity 120ms ease;
}

.rollback-bar:hover .rollback-bar-line {
  background-color: var(--accent-9);
}

.rollback-bar:hover .rollback-bar-handle {
  color: var(--accent-9);
}

.rollback-bar-dragging .rollback-bar-line {
  background-color: var(--accent-9);
}

.rollback-bar-dragging .rollback-bar-handle {
  color: var(--accent-9);
}

.rollback-bar-line {
  flex: 1;
  height: 2px;
  background-color: var(--neutral-6);
  border-radius: 1px;
  transition: background-color 120ms ease;
}

.rollback-bar-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
  color: var(--neutral-7);
  transition: color 120ms ease;
}

/* Expand/collapse transition */
.tree-expand-enter-active {
  transition: all 150ms ease-out;
  overflow: hidden;
}

.tree-expand-leave-active {
  transition: all 120ms ease-in;
  overflow: hidden;
}

.tree-expand-enter-from,
.tree-expand-leave-to {
  opacity: 0;
  max-height: 0;
}

.tree-expand-enter-to,
.tree-expand-leave-from {
  opacity: 1;
  max-height: 2000px;
}
</style>
