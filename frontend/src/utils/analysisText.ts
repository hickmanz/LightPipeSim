// Words and geometry helpers of the light path analysis: where a surface is, which way it faces, and the colours of a route.
import type { GroupGeometry } from "../api";

/** Colours of the steps of a route (first surface, second surface, ...): strong and easy to tell apart. */
export const STEP_COLORS = ["#2563eb", "#f59e0b", "#db2777", "#059669", "#7c3aed", "#ea580c", "#0891b2", "#65a30d"];

/** The colour of every surface of a route, in the order the light meets them (a surface that comes back keeps its colour). */
export function routeColors(route: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  let k = 0;
  for (const g of route) if (!(g in out)) out[g] = STEP_COLORS[k++ % STEP_COLORS.length];
  return out;
}

/** The frame of the exit surface: u along the exit map (left to right), v up the map, w out of the exit surface. */
export interface ExitFrame {
  o: number[];
  u: number[];
  v: number[];
  n: number[];
  /** Size of the exit map in mm. */
  L: number;
  W: number;
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: number[]) => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

export function exitFrame(det: { corners: number[][]; n: number[] } | undefined | null): ExitFrame | null {
  if (!det || det.corners.length < 4) return null;
  const [c0, c1, , c3] = det.corners;
  const du = sub(c1, c0);
  const dv = sub(c3, c0);
  return { o: c0, u: unit(du), v: unit(dv), n: unit(det.n), L: len(du), W: len(dv) };
}

export interface Box {
  u: [number, number];
  v: [number, number];
  w: [number, number];
}
/** A model-space box seen in the exit frame (the extent of its eight corners). */
export function boxInFrame(f: ExitFrame, bbox: number[][]): Box {
  const out: Box = { u: [Infinity, -Infinity], v: [Infinity, -Infinity], w: [Infinity, -Infinity] };
  for (let i = 0; i < 8; i++) {
    const p = [bbox[i & 1 ? 1 : 0][0], bbox[i & 2 ? 1 : 0][1], bbox[i & 4 ? 1 : 0][2]];
    const d = sub(p, f.o);
    const c = { u: dot(d, f.u), v: dot(d, f.v), w: dot(d, f.n) };
    for (const k of ["u", "v", "w"] as const) {
      out[k][0] = Math.min(out[k][0], c[k]);
      out[k][1] = Math.max(out[k][1], c[k]);
    }
  }
  return out;
}

/** Which way a surface faces, in the words of the exit map ("faces the exit", "faces the left end"). */
export function describeFacing(g: GroupGeometry | null | undefined, f: ExitFrame | null): string {
  if (!g) return "";
  if (!g.normal) return "several directions";
  if (!f) return "";
  const nw = dot(g.normal, f.n);
  if (nw > 0.8) return "faces the exit";
  if (nw < -0.8) return "faces away from the exit";
  const nu = dot(g.normal, f.u);
  const nv = dot(g.normal, f.v);
  const side = Math.abs(nu) >= Math.abs(nv) ? (nu > 0 ? "right end" : "left end") : nv > 0 ? "top edge of the map" : "bottom edge of the map";
  const tilt = nw > 0.3 ? ", tilted toward the exit" : nw < -0.3 ? ", tilted away from the exit" : "";
  return `faces the ${side}${tilt}`;
}

/** Where a surface sits along the exit surface and how far behind it ("20–35 % along, 4 mm behind the exit"). */
export function describePlace(g: GroupGeometry | null | undefined, f: ExitFrame | null): string {
  if (!g || !f) return "";
  const b = boxInFrame(f, g.bbox);
  const pct = (x: number) => Math.round(Math.min(100, Math.max(0, (x / (f.L || 1)) * 100)));
  const a = pct(b.u[0]);
  const z = pct(b.u[1]);
  const along = z - a >= 90 ? "the whole length" : a === z ? `${a} % along` : `${a}–${z} % along`;
  const depth = -(b.w[0] + b.w[1]) / 2;
  const behind = Math.abs(depth) < 0.3 ? "at the exit surface" : depth > 0 ? `${depth.toFixed(depth < 10 ? 1 : 0)} mm behind it` : `${(-depth).toFixed(1)} mm in front of it`;
  return `${along}, ${behind}`;
}

/** A hint for the table: facing and place in one short phrase. */
export function describeSurface(g: GroupGeometry | null | undefined, f: ExitFrame | null): string {
  const parts = [describeFacing(g, f), describePlace(g, f)].filter(Boolean);
  return parts.join(" · ");
}

/** "Reflector Tray:1 · face 7" -> the part part and the face part (for the two-line labels). */
export function splitName(name: string): { part: string; face: string } {
  const i = name.lastIndexOf(" · face ");
  return i < 0 ? { part: name, face: "" } : { part: name.slice(0, i), face: `face ${name.slice(i + 8)}` };
}
