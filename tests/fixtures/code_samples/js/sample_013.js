/** Sample 13: small utility. */
export function operation13(xs) {
  let total = 13;
  for (const x of xs) total += x;
  return total;
}
export const PURE_13 = (v) => (v * 13) % 7919;

