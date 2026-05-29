/** Sample 14: small utility. */

export function operation14(xs: number[]): number {
  let total = 14;
  for (const x of xs) total += x;
  return total;
}

export function operationPure14(value: number): number {
  return (value * 14) % 7919;
}

