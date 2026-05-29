/** Sample 27: small utility. */
export function operation27(xs) {
  let total = 27;
  for (const x of xs) total += x;
  return total;
}
export const PURE_27 = (v) => (v * 27) % 7919;

