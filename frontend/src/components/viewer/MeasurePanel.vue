<template>
  <Transition name="measure-panel">
    <div v-if="visible" class="measure-panel" @click.stop>
      <div class="measure-panel-header">
        <span class="measure-panel-title">MEASURE</span>
        <button
          class="measure-panel-close"
          @click="$emit('update:visible', false)"
          aria-label="Close panel"
        >
          <SquareX class="h-4 w-4" />
        </button>
      </div>
      <div class="measure-panel-body">
        <button
          class="section-item"
          :class="{ 'section-item-active': activeMeasureType === 'smart' }"
          @click="$emit('smart-measure')"
        >
          <Crosshair class="section-icon" />
          <span class="section-label">Smart Measure</span>
        </button>

        <!-- Current measurement info -->
        <div
          v-if="measureInfo && measureInfo.type"
          class="measure-info-section"
        >
          <div class="measure-info-divider" />
          <div class="measure-info-row">
            <span class="measure-info-label">{{ measureTypeLabel }}</span>
            <span class="measure-info-value">{{ measureValueLabel }}</span>
          </div>

          <!-- Radius / Diameter toggle -->
          <div v-if="canToggleRadiusDiameter" class="measure-toggle-row">
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.displayMode !== 'diameter',
              }"
              @click="$emit('toggle-radius-diameter')"
              title="Show as Radius"
            >
              <CircleDot class="measure-toggle-icon" />
              <span>R</span>
            </button>
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.displayMode === 'diameter',
              }"
              @click="$emit('toggle-radius-diameter')"
              title="Show as Diameter"
            >
              <Circle class="measure-toggle-icon" />
              <span>&#x2300;</span>
            </button>
          </div>

          <!-- Angle / Distance toggle -->
          <div v-if="canToggleAngleDistance" class="measure-toggle-row">
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.displayMode !== 'distance',
              }"
              @click="$emit('toggle-angle-distance')"
              title="Show as Angle"
            >
              <TriangleRight class="measure-toggle-icon" />
              <span>Angle</span>
            </button>
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.displayMode === 'distance',
              }"
              @click="$emit('toggle-angle-distance')"
              title="Show as Distance"
            >
              <Ruler class="measure-toggle-icon" />
              <span>Dist</span>
            </button>
          </div>

          <!-- Center / Edge toggle -->
          <div v-if="canToggleCenterEdge" class="measure-toggle-row">
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.arcMode === 'center',
              }"
              @click="$emit('toggle-center-edge')"
              title="Measure from arc center / cylinder axis"
            >
              <Crosshair class="measure-toggle-icon" />
              <span>Center</span>
            </button>
            <button
              class="measure-toggle-btn"
              :class="{
                'measure-toggle-active': measureInfo.arcMode !== 'center',
              }"
              @click="$emit('toggle-center-edge')"
              title="Measure from edge / surface closest point"
            >
              <Minus class="measure-toggle-icon" />
              <span>Edge</span>
            </button>
          </div>
        </div>

        <div class="measure-info-divider" />
        <button class="section-item" @click="$emit('clear-measurements')">
          <CircleX class="section-icon" />
          <span class="section-label">Clear measurements</span>
        </button>
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import {
  CircleX,
  Crosshair,
  SquareX,
  CircleDot,
  Circle,
  TriangleRight,
  Ruler,
  Minus,
} from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  activeMeasureType: string | null;
  measureInfo: {
    type: string | null;
    value: number | null;
    displayMode: string | null;
    id: string | null;
    arcCenters?: Record<string, unknown>;
    arcMode?: string | null;
  } | null;
}>();

defineEmits<{
  (e: "update:visible", value: boolean): void;
  (e: "smart-measure"): void;
  (e: "clear-measurements"): void;
  (e: "toggle-radius-diameter"): void;
  (e: "toggle-angle-distance"): void;
  (e: "toggle-center-edge"): void;
}>();

const canToggleRadiusDiameter = computed(() => {
  const t = props.measureInfo?.type;
  return (
    t === "smart-edge-radius" ||
    t === "smart-cylinder-radius" ||
    props.measureInfo?.displayMode === "diameter"
  );
});

const canToggleAngleDistance = computed(() => {
  const t = props.measureInfo?.type;
  return t === "smart-face-angle" || t === "smart-face-distance";
});

const canToggleCenterEdge = computed(() => {
  return props.measureInfo?.arcCenters != null;
});

const measureTypeLabel = computed(() => {
  const t = props.measureInfo?.type;
  if (!t) return "";
  const labels: Record<string, string> = {
    "smart-edge-length": "Edge Length",
    "smart-edge-radius": "Radius",
    "smart-cylinder-radius": "Cylinder Radius",
    "smart-edge-distance": "Edge Distance",
    "smart-face-angle": "Face Angle",
    "smart-face-distance": "Face Distance",
    "smart-face-edge-distance": "Face-Edge Distance",
    "smart-point-distance": "Point Distance",
    "smart-point-edge-distance": "Point-Edge Distance",
    "smart-point-face-distance": "Point-Face Distance",
  };
  if (props.measureInfo?.displayMode === "diameter") return "Diameter";
  return labels[t] ?? "Measurement";
});

const measureValueLabel = computed(() => {
  const v = props.measureInfo?.value;
  if (v == null) return "";
  const mode = props.measureInfo?.displayMode;
  if (mode === "angle") return `${v.toFixed(1)}\u00B0`;
  if (v < 0.001) return `${(v * 1000).toFixed(3)} \u00B5m`;
  if (v < 1) return `${v.toFixed(3)} mm`;
  if (v < 100) return `${v.toFixed(2)} mm`;
  return `${v.toFixed(1)} mm`;
});
</script>

<style scoped>
/* Migrated from global style.css */
.measure-panel-divider {
  height: 1px;
  background: var(--neutral-3);
  margin: 4px 0;
}

.measure-info-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.measure-info-divider {
  height: 1px;
  background: var(--neutral-3);
  margin: 2px 0;
}

.measure-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  font-size: 0.75rem;
}

.measure-info-label {
  color: var(--neutral-11);
  font-weight: 500;
}

.measure-info-value {
  color: var(--accent-11);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.measure-toggle-row {
  display: flex;
  gap: 4px;
  padding: 0 8px;
}

.measure-toggle-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--neutral-4);
  border-radius: 4px;
  background: transparent;
  color: var(--neutral-11);
  font-size: 0.6875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 120ms ease;
}

.measure-toggle-btn:hover {
  background: var(--neutral-2);
  border-color: var(--neutral-6);
}

.measure-toggle-btn.measure-toggle-active {
  background: var(--accent-3);
  border-color: var(--accent-7);
  color: var(--accent-11);
}

.measure-toggle-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
</style>
