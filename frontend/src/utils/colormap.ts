// Colour maps for the result images (all produce [r, g, b] in 0..255).

const TURBO: [number, number, number][] = [
  [0.19, 0.07, 0.23],
  [0.27, 0.32, 0.79],
  [0.14, 0.58, 0.99],
  [0.08, 0.8, 0.8],
  [0.3, 0.95, 0.52],
  [0.66, 0.99, 0.24],
  [0.93, 0.86, 0.2],
  [0.99, 0.6, 0.12],
  [0.86, 0.3, 0.05],
  [0.48, 0.02, 0.01],
];

const DIVERGING: [number, number, number][] = [
  [0.1, 0.25, 0.75],
  [0.45, 0.65, 0.95],
  [0.95, 0.95, 0.95],
  [0.95, 0.65, 0.45],
  [0.75, 0.1, 0.1],
];

function lerp(stops: [number, number, number][], t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return [
    (stops[i][0] * (1 - f) + stops[i + 1][0] * f) * 255,
    (stops[i][1] * (1 - f) + stops[i + 1][1] * f) * 255,
    (stops[i][2] * (1 - f) + stops[i + 1][2] * f) * 255,
  ];
}

export const turbo = (t: number) => lerp(TURBO, t);
export const diverging = (t: number) => lerp(DIVERGING, t);

export function cssGradient(kind: "turbo" | "diverging" = "turbo"): string {
  const stops = kind === "turbo" ? TURBO : DIVERGING;
  return `linear-gradient(to top, ${stops.map((s, i) => `rgb(${s.map((c) => Math.round(c * 255)).join(",")}) ${(i / (stops.length - 1)) * 100}%`).join(", ")})`;
}

export function fmtNum(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "–";
  const a = Math.abs(x);
  if (a === 0) return "0";
  if (a >= 1000) return x.toFixed(0);
  if (a >= 100) return x.toFixed(1);
  if (a >= 10) return x.toFixed(2);
  if (a >= 0.01) return x.toFixed(digits);
  return x.toExponential(2);
}

export const fmtPct = (x: number | null | undefined, digits = 1) => (x === null || x === undefined ? "–" : `${(x * 100).toFixed(digits)} %`);
