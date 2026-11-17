<template>
  <section class="res-card analysis-panel">
    <div class="hm-title"><span>Light path analysis — what makes this pattern?</span></div>
    <nav class="ana-tabs">
      <button v-for="t in tabs" :key="t.id" :class="{ on: tab === t.id }" @click="tab = t.id">
        <component :is="t.icon" :size="14" /> {{ t.label }}
      </button>
    </nav>
    <KeepAlive>
      <ContribTab v-if="tab === 'contrib'" :ctx="ctx" />
      <RegionTab v-else-if="tab === 'region'" :ctx="ctx" />
      <FamiliesTab v-else-if="tab === 'families'" :ctx="ctx" />
      <FlowTab v-else-if="tab === 'flow'" :ctx="ctx" />
      <GuidanceTab v-else :ctx="ctx" />
    </KeepAlive>
  </section>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Crosshair, GitBranch, Lightbulb, Route, Shapes } from "lucide-vue-next";
import type { AnalysisCtx } from "../composables/useAnalysisView";
import ContribTab from "./analysis/ContribTab.vue";
import RegionTab from "./analysis/RegionTab.vue";
import FamiliesTab from "./analysis/FamiliesTab.vue";
import FlowTab from "./analysis/FlowTab.vue";
import GuidanceTab from "./analysis/GuidanceTab.vue";

defineProps<{ ctx: AnalysisCtx }>();

const tab = ref<"contrib" | "region" | "families" | "flow" | "guidance">("contrib");
const tabs = [
  { id: "contrib" as const, label: "Surfaces", icon: Shapes },
  { id: "region" as const, label: "Where does it come from?", icon: Crosshair },
  { id: "families" as const, label: "Routes", icon: Route },
  { id: "flow" as const, label: "Flow diagram", icon: GitBranch },
  { id: "guidance" as const, label: "What to change", icon: Lightbulb },
];
</script>

<style scoped>
.ana-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--neutral-3); padding-bottom: 6px; }
.ana-tabs button {
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px;
  border: 1px solid transparent; border-radius: var(--radius-md);
  background: transparent; color: var(--neutral-10); font: inherit; font-size: 0.8rem; font-weight: 600; cursor: pointer;
}
.ana-tabs button:hover { background: var(--neutral-2); }
.ana-tabs button.on { background: var(--accent-3); color: var(--neutral-12); border-color: var(--accent-7); }
</style>
