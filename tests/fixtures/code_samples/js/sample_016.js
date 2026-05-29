/** Sample 16: small utility. */
export function operation16(xs) {
  let total = 16;
  for (const x of xs) total += x;
  return total;
}
export const PURE_16 = (v) => (v * 16) % 7919;

