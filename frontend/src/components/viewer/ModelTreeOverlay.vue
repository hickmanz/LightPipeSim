<template>
  <div v-if="visible" class="model-tree-overlay" @click.stop>
    <div class="model-tree-header">
      <h3 class="model-tree-title">Model Tree</h3>
      <button
        v-if="hasRollback"
        class="undo-rollback-btn"
        title="Clear Rollback"
        @click="handleUndoRollback"
      >
        <Undo2 :size="14" />
        Clear Rollback
      </button>
    </div>
    <div class="model-tree-content" ref="treeContentRef">
      <div v-if="!treeData" class="model-tree-empty">
        <p>Loading model tree...</p>
      </div>
      <TreeNode
        v-else
        :node="treeData"
        :level="0"
        :selected-node-ids="selectedNodeIds"
        :rollback-map="rollbackMap"
        @node-click="handleNodeClick"
        @visibility-toggle="handleVisibilityToggle"
        @node-contextmenu="handleNodeContextMenu"
        @rollback-change="handleRollbackChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { Undo2 } from "lucide-vue-next";
import TreeNode from "./TreeNode.vue";
import type { TreeNode as TreeNodeType } from "../../composables/viewer/useThreeViewer";

const props = defineProps<{
  visible: boolean;
  treeData: TreeNodeType | null;
  selectedNodeIds: number[];
  rollbackMap?: Map<number, number>;
}>();

const emit = defineEmits<{
  "node-click": [nodeId: number];
  "visibility-toggle": [nodeId: number];
  "node-contextmenu": [nodeId: number, x: number, y: number];
  "rollback-change": [nodeId: number, index: number];
  "undo-rollback": [];
}>();

const hasRollback = computed(() => {
  return props.rollbackMap ? props.rollbackMap.size > 0 : false;
});

const handleUndoRollback = () => {
  emit("undo-rollback");
};

const treeContentRef = ref<HTMLElement | null>(null);

const handleNodeClick = (nodeId: number) => {
  emit("node-click", nodeId);
};

const handleVisibilityToggle = (nodeId: number) => {
  emit("visibility-toggle", nodeId);
};

const handleNodeContextMenu = (nodeId: number, x: number, y: number) => {
  emit("node-contextmenu", nodeId, x, y);
};

const handleRollbackChange = (nodeId: number, index: number) => {
  emit("rollback-change", nodeId, index);
};

// Scroll to the most recently selected node when selection changes
watch(
  () => props.selectedNodeIds,
  async (ids) => {
    if (ids.length === 0 || !treeContentRef.value) return;
    const lastId = ids[ids.length - 1];
    await nextTick();
    const nodeElement = treeContentRef.value.querySelector(
      `[data-node-id="${lastId}"]`,
    );
    if (nodeElement) {
      const container = treeContentRef.value;
      const nodeRect = (nodeElement as HTMLElement).offsetTop;
      const nodeHeight = (nodeElement as HTMLElement).offsetHeight;
      const containerHeight = container.clientHeight;
      container.scrollTo({
        top: nodeRect - containerHeight / 2 + nodeHeight / 2,
        behavior: "smooth",
      });
    }
  },
);
</script>

<style scoped>
.model-tree-overlay {
  position: absolute;
  top: 0;
  left: calc(var(--icon-bar-width) + var(--panel-width));
  width: 370px;
  height: 100%;
  background: var(--neutral-1);
  border-right: 1px solid var(--neutral-3);
  z-index: 100;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-sm);
  transition: left 0.3s ease;
}

.model-tree-header {
  padding: 0.75rem var(--spacing-lg);
  border-bottom: 1px solid var(--neutral-3);
  background: var(--neutral-1);
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.model-tree-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--neutral-9);
  margin: 0;
}

.undo-rollback-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--neutral-7);
  background: var(--neutral-2);
  border: 1px solid var(--neutral-4);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.undo-rollback-btn:hover {
  color: var(--neutral-9);
  background: var(--neutral-3);
  border-color: var(--neutral-5);
}

.model-tree-content {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--spacing-sm) 0;
}

.model-tree-empty {
  padding: var(--spacing-2xl) var(--spacing-lg);
  text-align: center;
  color: var(--neutral-6);
  font-size: 0.875rem;
}

/* Scrollbar styling */
.model-tree-content::-webkit-scrollbar {
  width: 8px;
}

.model-tree-content::-webkit-scrollbar-track {
  background: transparent;
}

.model-tree-content::-webkit-scrollbar-thumb {
  background: var(--neutral-4);
  border-radius: var(--radius-sm);
}

.model-tree-content::-webkit-scrollbar-thumb:hover {
  background: var(--neutral-5);
}

.model-tree-content::-webkit-scrollbar-button {
  display: none;
}
</style>
