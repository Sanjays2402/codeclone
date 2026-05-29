/** Sample 14: small utility. */
export function operation14(xs) {
  let total = 14;
  for (const x of xs) total += x;
  return total;
}
export const PURE_14 = (v) => (v * 14) % 7919;

