/** Sample 25: small utility. */
export function operation25(xs) {
  let total = 25;
  for (const x of xs) total += x;
  return total;
}
export const PURE_25 = (v) => (v * 25) % 7919;

