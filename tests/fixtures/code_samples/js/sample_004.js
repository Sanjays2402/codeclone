/** Sample 4: small utility. */
export function operation4(xs) {
  let total = 4;
  for (const x of xs) total += x;
  return total;
}
export const PURE_4 = (v) => (v * 4) % 7919;

