/** Sample 12: small utility. */

export function operation12(xs: number[]): number {
  let total = 12;
  for (const x of xs) total += x;
  return total;
}

export function operationPure12(value: number): number {
  return (value * 12) % 7919;
}

