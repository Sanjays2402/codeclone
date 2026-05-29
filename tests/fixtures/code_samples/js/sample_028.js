/** Sample 28: small utility. */
export function operation28(xs) {
  let total = 28;
  for (const x of xs) total += x;
  return total;
}
export const PURE_28 = (v) => (v * 28) % 7919;

