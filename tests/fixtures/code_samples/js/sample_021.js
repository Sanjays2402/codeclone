/** Sample 21: small utility. */
export function operation21(xs) {
  let total = 21;
  for (const x of xs) total += x;
  return total;
}
export const PURE_21 = (v) => (v * 21) % 7919;

