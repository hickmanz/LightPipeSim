<template>
  <Transition name="section-panel">
    <div v-if="visible" class="section-panel" @click.stop>
      <div class="section-panel-header">
        <span class="section-panel-title">CROSS SECTIONS</span>
        <button
          class="section-panel-close"
          @click="$emit('update:visible', false)"
          aria-label="Close panel"
        >
          <SquareX />
        </button>
      </div>
      <div class="section-panel-body">
        <button class="section-item" @click="handleReset">
          <CircleX class="section-icon" />
          <span class="section-label">Reset cutting plane</span>
        </button>
        <label v-if="showCaps !== undefined" class="section-caps-row" title="Off: leave the cut open so you can see into the parts" @click.stop>
          <input type="checkbox" :checked="showCaps" @change="emit('update:showCaps', ($event.target as HTMLInputElement).checked)" />
          <span>Cap the cut (fill the ends)</span>
        </label>
        <button
          class="section-item"
          :class="{ 'section-item-active': activePlanes.has('face') }"
          :disabled="!hasSelectedFace && !activePlanes.has('face')"
          @click="handleFace(false)"
        >
          <span class="section-icon toolbar-cuttingplane-face"></span>
          <span class="section-label">Selected face</span>
          <div class="section-flip"></div>
        </button>
        <button
          class="section-item"
          :class="{ 'section-item-active': activePlanes.has('x') }"
          @click="handleX(false)"
        >
          <CrossSectionIcon
            :active="activePlanes.has('x')"
            class="section-icon"
          />
          <span class="section-label">Right Plane</span>
        </button>
        <div
          v-if="activePlanes.has('x')"
          class="section-distance-row"
          @click.stop
        >
          <span class="section-distance-label">X</span>
          <input
            type="number"
            class="section-distance-input"
            :value="planeDistances.x.toFixed(3)"
            @change="onDistanceChange('x', $event)"
            step="0.1"
          />
          <label class="section-flip-label" @click.stop>
            <input
              type="checkbox"
              v-model="localFlipX"
              @click.stop
              @change="handleX(true)"
            />
            <span>Flip</span>
          </label>
        </div>
        <button
          class="section-item"
          :class="{ 'section-item-active': activePlanes.has('y') }"
          @click="handleY(false)"
        >
          <CrossSectionIcon
            :active="activePlanes.has('y')"
            class="section-icon"
            :style="{ transform: 'rotate(-120deg)' }"
          />
          <span class="section-label">Top Plane</span>
        </button>
        <div
          v-if="activePlanes.has('y')"
          class="section-distance-row"
          @click.stop
        >
          <span class="section-distance-label">Y</span>
          <input
            type="number"
            class="section-distance-input"
            :value="planeDistances.y.toFixed(3)"
            @change="onDistanceChange('y', $event)"
            step="0.1"
          />
          <label class="section-flip-label" @click.stop>
            <input
              type="checkbox"
              v-model="localFlipY"
              @click.stop
              @change="handleY(true)"
            />
            <span>Flip</span>
          </label>
        </div>
        <button
          class="section-item"
          :class="{ 'section-item-active': activePlanes.has('z') }"
          @click="handleZ(false)"
        >
          <CrossSectionIcon
            :active="activePlanes.has('z')"
            class="section-icon"
            :style="{ transform: 'rotate(120deg)' }"
          />
          <span class="section-label">Front Plane</span>
        </button>
        <div
          v-if="activePlanes.has('z')"
          class="section-distance-row"
          @click.stop
        >
          <span class="section-distance-label">Z</span>
          <input
            type="number"
            class="section-distance-input"
            :value="planeDistances.z.toFixed(3)"
            @change="onDistanceChange('z', $event)"
            step="0.1"
          />
          <label class="section-flip-label" @click.stop>
            <input
              type="checkbox"
              v-model="localFlipZ"
              @click.stop
              @change="handleZ(true)"
            />
            <span>Flip</span>
          </label>
        </div>
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { CircleX, SquareX } from "lucide-vue-next";
import { CrossSectionIcon } from "../icons/customIcons";

const props = defineProps<{
  visible: boolean;
  activePlanes: Set<"x" | "y" | "z" | "face">;
  flipX: boolean;
  flipY: boolean;
  flipZ: boolean;
  flipFace: boolean;
  hasSelectedFace: boolean;
  planeDistances: Record<"x" | "y" | "z", number>;
  /** Whether the cut faces are filled; the option is hidden when not passed. */
  showCaps?: boolean;
}>();

const emit = defineEmits<{
  (e: "update:showCaps", value: boolean): void;
  (e: "update:visible", value: boolean): void;
  (e: "reset"): void;
  (e: "face", fromCheckbox: boolean, flip: boolean): void;
  (e: "planeX", fromCheckbox: boolean, flip: boolean): void;
  (e: "planeY", fromCheckbox: boolean, flip: boolean): void;
  (e: "planeZ", fromCheckbox: boolean, flip: boolean): void;
  (e: "update:flipX", value: boolean): void;
  (e: "update:flipY", value: boolean): void;
  (e: "update:flipZ", value: boolean): void;
  (e: "update:flipFace", value: boolean): void;
  (e: "setDistance", axis: "x" | "y" | "z", distance: number): void;
}>();

const localFlipX = ref(props.flipX);
const localFlipY = ref(props.flipY);
const localFlipZ = ref(props.flipZ);
const localFlipFace = ref(props.flipFace);

watch(
  () => props.flipX,
  (v) => (localFlipX.value = v),
);
watch(
  () => props.flipY,
  (v) => (localFlipY.value = v),
);
watch(
  () => props.flipZ,
  (v) => (localFlipZ.value = v),
);
watch(
  () => props.flipFace,
  (v) => (localFlipFace.value = v),
);

const handleReset = () => emit("reset");

const handleFace = (fromCheckbox: boolean) => {
  emit("update:flipFace", localFlipFace.value);
  emit("face", fromCheckbox, localFlipFace.value);
};

const handleX = (fromCheckbox: boolean) => {
  emit("update:flipX", localFlipX.value);
  emit("planeX", fromCheckbox, localFlipX.value);
};

const handleY = (fromCheckbox: boolean) => {
  emit("update:flipY", localFlipY.value);
  emit("planeY", fromCheckbox, localFlipY.value);
};

const handleZ = (fromCheckbox: boolean) => {
  emit("update:flipZ", localFlipZ.value);
  emit("planeZ", fromCheckbox, localFlipZ.value);
};

const onDistanceChange = (axis: "x" | "y" | "z", event: Event) => {
  const input = event.target as HTMLInputElement;
  const val = parseFloat(input.value);
  if (!Number.isNaN(val)) {
    emit("setDistance", axis, val);
  }
};
</script>

<style scoped>
/* Migrated from global style.css */
.section-caps-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 0.8125rem;
  color: var(--neutral-10);
  cursor: pointer;
  user-select: none;
}
.section-caps-row input {
  margin: 0;
  cursor: pointer;
}

.section-flip {
  display: flex;
  align-items: center;
  gap: 4px;
}

.section-flip-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--neutral-6);
  cursor: pointer;
  user-select: none;
}

.section-flip-label input[type="checkbox"] {
  cursor: pointer;
  margin: 0;
}

.section-item-active .section-flip-label {
  color: var(--accent-7);
}

.section-distance-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
}

.section-distance-label {
  font-size: 0.75rem;
  color: var(--neutral-10);
  min-width: 14px;
  text-transform: uppercase;
  font-weight: 600;
}

.section-distance-input {
  width: 80px;
  padding: 2px 6px;
  border: 1px solid var(--neutral-5);
  border-radius: 4px;
  background: var(--neutral-2);
  color: var(--neutral-12);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  outline: none;
  transition: border-color 120ms ease;
}

.section-distance-input:focus {
  border-color: var(--accent-8);
}

.toolbar-cuttingplane-reset,
.toolbar-cuttingplane-face,
.toolbar-cuttingplane-x,
.toolbar-cuttingplane-y,
.toolbar-cuttingplane-z,
.toolbar-cuttingplane-hide {
  width: 30px;
  height: 30px;
  background: url(/toolbarsprite.png) no-repeat top left;
  display: block;
}

.toolbar-cuttingplane-reset {
  background-position: -6px -49px;
}

.toolbar-cuttingplane-face {
  background-position: -6px -49px;
}

.toolbar-cuttingplane-x {
  background-position: -345px -266px;
}

.toolbar-cuttingplane-y {
  background-position: -345px -220px;
}

.toolbar-cuttingplane-z {
  background-position: -345px -180px;
}

.toolbar-cuttingplane-hide {
  background-position: -6px -49px;
}
</style>
