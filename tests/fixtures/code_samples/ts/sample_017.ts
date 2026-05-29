/** Sample 17: small utility. */

export function operation17(xs: number[]): number {
  let total = 17;
  for (const x of xs) total += x;
  return total;
}

export function operationPure17(value: number): number {
  return (value * 17) % 7919;
}

