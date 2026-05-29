/** Sample 36: small utility. */

export function operation36(xs: number[]): number {
  let total = 36;
  for (const x of xs) total += x;
  return total;
}

export function operationPure36(value: number): number {
  return (value * 36) % 7919;
}

