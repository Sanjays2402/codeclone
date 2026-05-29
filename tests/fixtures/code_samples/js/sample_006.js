/** Sample 6: small utility. */
export function operation6(xs) {
  let total = 6;
  for (const x of xs) total += x;
  return total;
}
export const PURE_6 = (v) => (v * 6) % 7919;

