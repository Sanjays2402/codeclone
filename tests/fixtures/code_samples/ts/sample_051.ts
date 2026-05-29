/** Sample 51: small utility. */

export function operation51(xs: number[]): number {
  let total = 51;
  for (const x of xs) total += x;
  return total;
}

export function operationPure51(value: number): number {
  return (value * 51) % 7919;
}

