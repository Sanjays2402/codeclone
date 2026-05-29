/** Sample 25: small utility. */

export function operation25(xs: number[]): number {
  let total = 25;
  for (const x of xs) total += x;
  return total;
}

export function operationPure25(value: number): number {
  return (value * 25) % 7919;
}

