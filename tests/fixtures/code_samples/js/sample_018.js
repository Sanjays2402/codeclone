/** Sample 18: small utility. */
export function operation18(xs) {
  let total = 18;
  for (const x of xs) total += x;
  return total;
}
export const PURE_18 = (v) => (v * 18) % 7919;

