/** Sample 9: small utility. */
export function operation9(xs) {
  let total = 9;
  for (const x of xs) total += x;
  return total;
}
export const PURE_9 = (v) => (v * 9) % 7919;

