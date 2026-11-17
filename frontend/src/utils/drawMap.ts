import { diverging, turbo } from "./colormap";

export interface DrawOptions {
  diverging?: boolean;
  log?: boolean;
  /** true: row 0 is drawn at the bottom (v increases upwards), false: row 0 at the top (3D texture order) */
  flipV?: boolean;
  /** draw these colours instead of a colour map (rows x cols x rgb 0..255) */
  rgb?: number[][][] | null;
}

export function drawMap(
  canvas: HTMLCanvasElement,
  values: number[][],
  valid: number[][] | null,
  vmin: number,
  vmax: number,
  opts: DrawOptions = {},
): void {
  const nv = values.length;
  const nu = values[0]?.length ?? 0;
  canvas.width = nu;
  canvas.height = nv;
  const ctx = canvas.getContext("2d");
  if (!ctx || !nu || !nv) return;
  const img = ctx.createImageData(nu, nv);
  const span = vmax - vmin || 1;
  const lo = opts.log ? Math.log10(Math.max(vmin, vmax * 1e-3)) : vmin;
  const hi = opts.log ? Math.log10(Math.max(vmax, 1e-30)) : vmax;
  const lspan = hi - lo || 1;
  for (let y = 0; y < nv; y++) {
    const dy = opts.flipV ? nv - 1 - y : y;
    for (let x = 0; x < nu; x++) {
      const o = (dy * nu + x) * 4;
      if (valid && !valid[y][x]) {
        img.data[o] = 38;
        img.data[o + 1] = 40;
        img.data[o + 2] = 46;
        img.data[o + 3] = 255;
        continue;
      }
      let rgb: number[];
      if (opts.rgb) rgb = opts.rgb[y][x];
      else {
        const val = values[y][x];
        const t = opts.log ? (Math.log10(Math.max(val, 1e-30)) - lo) / lspan : (val - vmin) / span;
        rgb = opts.diverging ? diverging(t) : turbo(t);
      }
      img.data[o] = rgb[0];
      img.data[o + 1] = rgb[1];
      img.data[o + 2] = rgb[2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}
