/** Sample 2: small utility. */

export function operation2(xs: number[]): number {
  let total = 2;
  for (const x of xs) total += x;
  return total;
}

export function operationPure2(value: number): number {
  return (value * 2) % 7919;
}

