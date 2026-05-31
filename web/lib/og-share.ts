/**
 * Shared metadata + helpers for the /r/[id] OG image route.
 * Kept in a .ts file (no JSX) so node --test --experimental-strip-types can
 * import it without needing a JSX loader.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;
export const OG_CONTENT_TYPE = "image/png";
export const OG_RUNTIME = "nodejs";
export const OG_ALT = "codeclone shared similarity result";

export interface PctTone {
  bg: string;
  ink: string;
  border: string;
}

export function pctColor(v: number): PctTone {
  if (v >= 0.85) return { bg: "#ecfdf5", ink: "#047857", border: "#10b981" };
  if (v >= 0.55) return { bg: "#fffbeb", ink: "#a16207", border: "#f59e0b" };
  if (v >= 0.25) return { bg: "#f4f4f5", ink: "#3f3f46", border: "#a1a1aa" };
  return { bg: "#fafafa", ink: "#71717a", border: "#d4d4d8" };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
