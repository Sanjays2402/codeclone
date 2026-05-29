/** Sample 35: small utility. */

export function operation35(xs: number[]): number {
  let total = 35;
  for (const x of xs) total += x;
  return total;
}

export function operationPure35(value: number): number {
  return (value * 35) % 7919;
}

