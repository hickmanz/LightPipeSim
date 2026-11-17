<template>
  <div class="form-grid">
    <label class="field"><span>Name</span><input v-model="doc.name" :disabled="readonly" /></label>

    <div class="field">
      <span>Emitting area (mm)</span>
      <div class="inline">
        <select :value="doc.emitter?.shape ?? 'rect'" :disabled="readonly" @change="setShape(($event.target as HTMLSelectElement).value)">
          <option value="point">Point</option>
          <option value="rect">Rectangle</option>
          <option value="disc">Disc</option>
        </select>
        <template v-if="(doc.emitter?.shape ?? 'rect') === 'rect'">
          <input type="number" step="0.1" min="0.01" :value="doc.emitter?.size?.[0] ?? 1" :disabled="readonly" @input="setSize(0, $event)" />
          <span>×</span>
          <input type="number" step="0.1" min="0.01" :value="doc.emitter?.size?.[1] ?? 1" :disabled="readonly" @input="setSize(1, $event)" />
        </template>
        <template v-else-if="doc.emitter?.shape === 'disc'">
          <input type="number" step="0.1" min="0.01" :value="doc.emitter?.size?.[0] ?? 1" :disabled="readonly" @input="setSize(0, $event)" />
          <span>diameter</span>
        </template>
      </div>
    </div>

    <div v-for="(ch, i) in doc.channels" :key="i" class="channel-card">
      <div class="channel-head">
        <strong>Channel {{ i + 1 }}</strong>
        <span class="muted small">A channel is one emitter in the package (e.g. the blue die, or the whole white LED). RGB LEDs have three; drive them separately in States.</span>
        <button v-if="doc.channels.length > 1 && !readonly" class="icon-btn" title="Remove channel" @click="doc.channels.splice(i, 1)"><X :size="14" /></button>
      </div>
      <div class="inline">
        <label class="field narrow"><span>Id</span><input v-model="ch.id" :disabled="readonly" /></label>
        <label class="field"><span>Name</span><input v-model="ch.name" :disabled="readonly" /></label>
        <label class="field narrow">
          <span>Flux (lm)</span>
          <input v-model.number="ch.flux_lm" type="number" step="0.1" min="0" :disabled="readonly" />
        </label>
      </div>

      <div class="field">
        <span>Colour (spectrum)</span>
        <select :value="ch.spectrum.type" :disabled="readonly" @change="setSpectrum(ch, ($event.target as HTMLSelectElement).value)">
          <option value="phosphor_white">White LED by colour temperature</option>
          <option value="gaussian">Single colour: peak wavelength and width</option>
          <option value="table">Measured spectrum (table)</option>
        </select>
        <div v-if="ch.spectrum.type === 'phosphor_white'" class="inline">
          <label class="mini">CCT (K) <input v-model.number="ch.spectrum.cct" type="number" step="100" min="2000" max="10000" :disabled="readonly" /></label>
        </div>
        <div v-else-if="ch.spectrum.type === 'gaussian'" class="inline">
          <label class="mini">Peak (nm) <input v-model.number="ch.spectrum.peak" type="number" step="1" min="380" max="780" :disabled="readonly" /></label>
          <label class="mini">FWHM (nm) <input v-model.number="ch.spectrum.fwhm" type="number" step="1" min="5" max="200" :disabled="readonly" /></label>
        </div>
        <textarea
          v-else-if="ch.spectrum.type === 'table'"
          class="table-area"
          rows="5"
          :value="pairsText(ch.spectrum.lambda, ch.spectrum.values)"
          :disabled="readonly"
          placeholder="wavelength nm, relative power"
          @change="setPairs(ch.spectrum, 'lambda', 'values', $event)"
        />
      </div>

      <div class="field">
        <span>Light source data</span>
        <select :value="ch.source ? 'rays' : 'pattern'" :disabled="readonly" @change="setSourceKind(ch, ($event.target as HTMLSelectElement).value)">
          <option value="pattern">Datasheet: angular distribution</option>
          <option value="rays">Measured ray set (text file)</option>
        </select>
        <div v-if="ch.source" class="ray-source">
          <p v-if="ch.source.count" class="small">
            <strong>{{ ch.source.filename || "ray set" }}</strong>: {{ ch.source.count.toLocaleString() }} rays, source size
            {{ ch.source.extentMm.map((v) => v.toFixed(2)).join(" × ") }} mm,
            {{ (ch.source.backwardFraction * 100).toFixed(1) }} % of flux travelling backwards (ignored),
            {{ ch.source.hasWavelength ? "wavelength per ray" : "no wavelengths, uses the colour above" }}.
          </p>
          <p v-else class="muted small">No file loaded yet.</p>
          <label v-if="!readonly" class="btn small file-btn">
            <Upload :size="14" /> {{ ch.source.count ? "Replace file" : "Choose ray file" }}
            <input type="file" accept=".txt,.dat,.csv,.src,.ray,text/plain" hidden @change="loadRays(ch, $event)" />
          </label>
          <p v-if="rayError" class="error small">{{ rayError }}</p>
          <p class="muted small">
            One ray per line: x y z l m n flux [wavelength nm]. Position in mm relative to the LED face centre (z along the emission axis),
            direction cosines l m n. Flux in the channel is the total of the forward rays. Binary and XML vendor files (for example TM-25 or Zemax DAT) must be exported to this text form first.
          </p>
        </div>
      </div>

      <div v-if="!ch.source" class="field">
        <span>Angular distribution</span>
        <select :value="ch.pattern.type" :disabled="readonly" @change="setPattern(ch, ($event.target as HTMLSelectElement).value)">
          <option value="half_angle">By half-intensity angle (datasheet viewing angle)</option>
          <option value="lambertian">Cosine power</option>
          <option value="table">Polar table (angle, relative intensity)</option>
        </select>
        <div v-if="ch.pattern.type === 'half_angle'" class="inline">
          <label class="mini">Half-intensity angle ±(°) <input v-model.number="ch.pattern.half_angle_deg" type="number" step="1" min="5" max="89" :disabled="readonly" /></label>
          <span class="muted small">A datasheet 120° viewing angle is ±60° here.</span>
        </div>
        <div v-else-if="ch.pattern.type === 'lambertian'" class="inline">
          <label class="mini">Exponent <input v-model.number="ch.pattern.exponent" type="number" step="0.1" min="0" :disabled="readonly" /></label>
          <span class="muted small">1 = Lambertian (±60° half intensity)</span>
        </div>
        <textarea
          v-else-if="ch.pattern.type === 'table'"
          class="table-area"
          rows="6"
          :value="pairsText(ch.pattern.angles, ch.pattern.intensity)"
          :disabled="readonly"
          placeholder="angle from axis in degrees, relative intensity"
          @change="setPairs(ch.pattern, 'angles', 'intensity', $event)"
        />
      </div>
    </div>
    <button v-if="!readonly" class="btn small" @click="addChannel"><Plus :size="14" /> Add channel</button>

    <label class="field"><span>Notes</span><textarea v-model="doc.notes" rows="2" :disabled="readonly" /></label>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Plus, Upload, X } from "lucide-vue-next";
import { api } from "../../api";
import type { LedChannel, LedModel } from "../../api";

const props = defineProps<{ doc: LedModel; readonly?: boolean }>();

function setShape(shape: string) {
  props.doc.emitter = { shape, size: shape === "point" ? [] : shape === "disc" ? [1] : [1.6, 1.6] };
}
function setSize(i: number, e: Event) {
  const v = parseFloat((e.target as HTMLInputElement).value);
  const em = props.doc.emitter ?? { shape: "rect", size: [1, 1] };
  const size = [...(em.size ?? [])];
  size[i] = Number.isFinite(v) ? v : 1;
  props.doc.emitter = { ...em, size };
}
function setSpectrum(ch: LedChannel, t: string) {
  if (t === "phosphor_white") ch.spectrum = { type: t, cct: 5000 };
  else if (t === "gaussian") ch.spectrum = { type: t, peak: 525, fwhm: 30 };
  else ch.spectrum = { type: t, lambda: [450, 550, 650], values: [1, 1, 1] };
}
function setPattern(ch: LedChannel, t: string) {
  if (t === "half_angle") ch.pattern = { type: t, half_angle_deg: 60 };
  else if (t === "lambertian") ch.pattern = { type: t, exponent: 1 };
  else ch.pattern = { type: t, angles: [0, 30, 60, 90], intensity: [1, 0.85, 0.5, 0] };
}
function pairsText(a: unknown, b: unknown): string {
  if (!Array.isArray(a) || !Array.isArray(b)) return "";
  return a.map((x, i) => `${x}, ${b[i]}`).join("\n");
}
function setPairs(obj: Record<string, unknown>, ka: string, kb: string, e: Event) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const line of (e.target as HTMLTextAreaElement).value.split(/\r?\n/)) {
    const m = line.split(/[,;\s\t]+/).filter(Boolean).map(Number);
    if (m.length >= 2 && m.every(Number.isFinite)) {
      xs.push(m[0]);
      ys.push(m[1]);
    }
  }
  obj[ka] = xs;
  obj[kb] = ys;
}
const rayError = ref("");
function setSourceKind(ch: LedChannel, kind: string) {
  rayError.value = "";
  if (kind === "rays") ch.source = { type: "rays", file: "", count: 0, hasWavelength: false, extentMm: [0, 0, 0], backwardFraction: 0 };
  else delete ch.source;
}
async function loadRays(ch: LedChannel, e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  rayError.value = "";
  try {
    const info = await api.importRays(file);
    ch.source = { type: "rays", file: info.file, filename: file.name, count: info.count, hasWavelength: info.hasWavelength, extentMm: info.extentMm, backwardFraction: info.backwardFraction, angles: info.angles, intensity: info.intensity };
    if (info.spectrum) ch.spectrum = info.spectrum;
  } catch (err) {
    rayError.value = (err as Error).message;
  }
}
function addChannel() {
  const n = props.doc.channels.length + 1;
  props.doc.channels.push({ id: `C${n}`, name: `Channel ${n}`, flux_lm: 5, spectrum: { type: "gaussian", peak: 525, fwhm: 30 }, pattern: { type: "half_angle", half_angle_deg: 60 } });
}
</script>
