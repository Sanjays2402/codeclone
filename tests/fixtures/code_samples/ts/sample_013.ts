/** Sample 13: small utility. */

export function operation13(xs: number[]): number {
  let total = 13;
  for (const x of xs) total += x;
  return total;
}

export function operationPure13(value: number): number {
  return (value * 13) % 7919;
}

