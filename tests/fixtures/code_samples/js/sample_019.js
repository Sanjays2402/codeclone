/** Sample 19: small utility. */
export function operation19(xs) {
  let total = 19;
  for (const x of xs) total += x;
  return total;
}
export const PURE_19 = (v) => (v * 19) % 7919;

