/** Sample 24: small utility. */
export function operation24(xs) {
  let total = 24;
  for (const x of xs) total += x;
  return total;
}
export const PURE_24 = (v) => (v * 24) % 7919;

