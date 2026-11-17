<template>
  <div class="curve-editor">
    <select :value="kind" :disabled="readonly" @change="setKind(($event.target as HTMLSelectElement).value)">
      <option v-for="k in kinds" :key="k" :value="k">{{ labels[k] }}</option>
    </select>
    <template v-if="kind === 'constant'">
      <input type="number" step="any" :value="constValue" :disabled="readonly" @input="emitConst(($event.target as HTMLInputElement).value)" />
    </template>
    <template v-else-if="kind === 'cauchy'">
      <label class="mini">A <input type="number" step="any" :value="cur.A" :disabled="readonly" @input="patch('A', $event)" /></label>
      <label class="mini">B (µm²) <input type="number" step="any" :value="cur.B ?? 0" :disabled="readonly" @input="patch('B', $event)" /></label>
      <label class="mini">C (µm⁴) <input type="number" step="any" :value="cur.C ?? 0" :disabled="readonly" @input="patch('C', $event)" /></label>
    </template>
    <template v-else-if="kind === 'power'">
      <label class="mini">value @ λ0 <input type="number" step="any" :value="cur.value" :disabled="readonly" @input="patch('value', $event)" /></label>
      <label class="mini">λ0 (nm) <input type="number" step="any" :value="cur.lambda0 ?? 550" :disabled="readonly" @input="patch('lambda0', $event)" /></label>
      <label class="mini">exponent <input type="number" step="any" :value="cur.exponent ?? -1" :disabled="readonly" @input="patch('exponent', $event)" /></label>
    </template>
    <template v-else-if="kind === 'table'">
      <textarea class="table-area" rows="5" :value="tableText" :disabled="readonly" placeholder="wavelength nm, value&#10;450, 1.59&#10;550, 1.58" @change="setTable(($event.target as HTMLTextAreaElement).value)" />
    </template>
    <template v-else>
      <span class="muted small">This curve type ({{ kind }}) can be edited in JSON mode.</span>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

type Cur = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const props = defineProps<{ modelValue: number | Cur | undefined; kinds: string[]; readonly?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [v: number | Cur] }>();

const labels: Record<string, string> = { constant: "Constant", cauchy: "Cauchy (n vs λ)", power: "Power law", table: "Table (λ, value)", sellmeier: "Sellmeier" };

const kind = computed(() => (typeof props.modelValue === "number" || props.modelValue == null ? "constant" : String((props.modelValue as Cur).type ?? "constant")));
const cur = computed<Cur>(() => (typeof props.modelValue === "object" && props.modelValue ? (props.modelValue as Cur) : {}));
const constValue = computed(() => (typeof props.modelValue === "number" ? props.modelValue : (cur.value.value ?? 0)));

function num(e: Event | string): number {
  const v = typeof e === "string" ? e : (e.target as HTMLInputElement).value;
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
}
function emitConst(v: string) {
  emit("update:modelValue", num(v));
}
function patch(key: string, e: Event) {
  emit("update:modelValue", { ...cur.value, [key]: num(e) });
}
function setKind(k: string) {
  const base = constValue.value || 0;
  if (k === "constant") emit("update:modelValue", base || 0);
  else if (k === "cauchy") emit("update:modelValue", { type: "cauchy", A: base || 1.5, B: 0.005, C: 0 });
  else if (k === "power") emit("update:modelValue", { type: "power", value: base || 0.001, lambda0: 550, exponent: -1 });
  else if (k === "table") emit("update:modelValue", { type: "table", lambda: [380, 780], values: [base, base] });
}
const tableText = computed(() => {
  const c = cur.value;
  if (!Array.isArray(c.lambda)) return "";
  return c.lambda.map((l: number, i: number) => `${l}, ${c.values[i]}`).join("\n");
});
function setTable(text: string) {
  const lambda: number[] = [];
  const values: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.split(/[,;\s\t]+/).filter(Boolean).map(Number);
    if (m.length >= 2 && m.every(Number.isFinite)) {
      lambda.push(m[0]);
      values.push(m[1]);
    }
  }
  emit("update:modelValue", { type: "table", lambda, values });
}
</script>
