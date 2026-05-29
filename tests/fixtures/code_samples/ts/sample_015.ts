/** Sample 15: small utility. */

export function operation15(xs: number[]): number {
  let total = 15;
  for (const x of xs) total += x;
  return total;
}

export function operationPure15(value: number): number {
  return (value * 15) % 7919;
}

