export function fmtVolume(mm3: number): string {
  if (mm3 >= 1e6) return `${(mm3 / 1e6).toFixed(2)} dm³`;
  if (mm3 >= 1e3) return `${(mm3 / 1e3).toFixed(2)} cm³`;
  if (mm3 >= 100) return `${mm3.toFixed(0)} mm³`;
  if (mm3 >= 1) return `${mm3.toFixed(1)} mm³`;
  if (mm3 >= 0.01) return `${mm3.toFixed(3)} mm³`;
  return `${mm3.toExponential(1)} mm³`;
}

export function fmtLength(mm: number): string {
  if (mm >= 100) return `${mm.toFixed(0)} mm`;
  if (mm >= 10) return `${mm.toFixed(1)} mm`;
  if (mm >= 0.1) return `${mm.toFixed(2)} mm`;
  return `${mm.toFixed(3)} mm`;
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function fmtAgo(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

/** Parent assembly portion of an instance path, e.g. "A/B/Part" -> "A/B". */
export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
