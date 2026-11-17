<template>
  <div class="performance-overlay">
    <div class="stats-section">
      <div class="stats-row fps-row">{{ stats.fps }} FPS</div>
      <div class="stats-row frame-time">
        {{ stats.frameTimeMs.toFixed(1) }} ms
      </div>
    </div>
    <div class="stats-section">
      <div class="stats-header">Render</div>
      <div class="stats-row">Calls: {{ stats.calls }}</div>
      <div class="stats-row">Tris: {{ formatNumber(stats.triangles) }}</div>
      <div class="stats-row">Lines: {{ stats.lines }}</div>
    </div>
    <div class="stats-section">
      <div class="stats-header">Model</div>
      <div class="stats-row">File: {{ formatFileSize(stats.fileSize) }}</div>
      <div class="stats-row">
        Verts: {{ formatVertexCount(stats.vertices) }}
      </div>
      <div class="stats-row">Meshes: {{ stats.meshes }}</div>
    </div>
    <div class="stats-section">
      <div class="stats-header">Loading</div>
      <div class="stats-row">
        Download: {{ formatDuration(stats.downloadMs) }}
      </div>
      <div class="stats-row">
        Parse/Decode: {{ formatDuration(stats.parseDecodeMs) }}
      </div>
      <div class="stats-row">
        Scene Build: {{ formatDuration(stats.sceneBuildMs) }}
      </div>
      <div class="stats-row">BVH: {{ formatDuration(stats.bvhMs) }}</div>
      <div class="stats-row">
        BBox+Camera: {{ formatDuration(stats.bboxCameraMs) }}
      </div>
      <div class="stats-row">Caps: {{ formatDuration(stats.capsMs) }}</div>
      <div class="stats-row">
        Total: {{ formatDuration(stats.totalModelLoadMs) }}
      </div>
    </div>
    <div class="stats-section">
      <div class="stats-header">Memory</div>
      <div class="stats-row">Geom: {{ stats.geometries }}</div>
      <div class="stats-row">Tex: {{ stats.textures }}</div>
      <div class="stats-row">Heap: {{ formatMemory(stats.jsHeapMB) }}</div>
    </div>
    <div class="stats-section debug-section">
      <label class="debug-toggle">
        <input
          type="checkbox"
          :checked="raycastDebug"
          @change="
            $emit(
              'update:raycastDebug',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        Raycast Debug
      </label>
      <label class="debug-toggle">
        <input
          type="checkbox"
          :checked="bboxDebug"
          @change="
            $emit(
              'update:bboxDebug',
              ($event.target as HTMLInputElement).checked,
            )
          "
        />
        Show BBoxes
      </label>
    </div>
    <div class="stats-section debug-section">
      <button class="debug-btn" @click="$emit('export-camera')">
        Export Camera
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface PerformanceStats {
  // Frame stats
  fps: number;
  frameTimeMs: number;
  // Render stats
  calls: number;
  triangles: number;
  lines: number;
  // Model stats
  fileSize: number | null;
  vertices: number;
  meshes: number;
  // Model loading timings (ms)
  downloadMs: number | null;
  downloadPercent: number | null;
  parseDecodeMs: number | null;
  sceneBuildMs: number | null;
  bvhMs: number | null;
  bboxCameraMs: number | null;
  capsMs: number | null;
  totalModelLoadMs: number | null;
  modelLoadStartedAt: number | null;
  loadingPhase: string | null;
  loadingPhaseStartedAt: number | null;
  downloadStartedAt: number | null;
  parseDecodeStartedAt: number | null;
  sceneBuildStartedAt: number | null;
  bvhStartedAt: number | null;
  bboxCameraStartedAt: number | null;
  capsStartedAt: number | null;
  // Memory stats
  geometries: number;
  textures: number;
  jsHeapMB: number | null;
}

defineProps<{
  stats: PerformanceStats;
  raycastDebug: boolean;
  bboxDebug: boolean;
}>();

defineEmits<{
  "update:raycastDebug": [value: boolean];
  "update:bboxDebug": [value: boolean];
  "export-camera": [];
}>();

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (bytes / 1024).toFixed(0) + " KB";
}

function formatVertexCount(count: number): string {
  if (count === 0) return "-";
  if (count >= 1000000) {
    return (count / 1000000).toFixed(2) + "M";
  }
  if (count >= 1000) {
    return (count / 1000).toFixed(1) + "K";
  }
  return count.toString();
}

function formatMemory(mb: number | null): string {
  if (mb === null) return "-";
  return mb.toFixed(1) + " MB";
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
</script>

<style scoped>
.performance-overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.8);
  color: #fff;
  padding: 8px 12px;
  font: 11px monospace;
  pointer-events: none;
  z-index: 100;
  border-radius: 4px;
  min-width: 120px;
}

.stats-section {
  margin-bottom: 6px;
}

.stats-section:last-child {
  margin-bottom: 0;
}

.stats-header {
  font-weight: bold;
  color: #aaa;
  margin-bottom: 2px;
}

.stats-row {
  line-height: 1.4;
}

.fps-row {
  font-size: 16px;
  font-weight: bold;
  color: #0f0;
}

.frame-time {
  font-size: 10px;
  color: #888;
}

.debug-section {
  border-top: 1px solid #444;
  padding-top: 6px;
  margin-top: 2px;
}

.debug-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  pointer-events: auto;
  font-size: 11px;
}

.debug-toggle input {
  cursor: pointer;
  margin: 0;
}

.debug-btn {
  pointer-events: auto;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  border: 1px solid #555;
  border-radius: 3px;
  padding: 2px 8px;
  font: 11px monospace;
  width: 100%;
}

.debug-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
