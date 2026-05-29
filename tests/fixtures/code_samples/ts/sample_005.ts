/** Sample 5: small utility. */

export function operation5(xs: number[]): number {
  let total = 5;
  for (const x of xs) total += x;
  return total;
}

export function operationPure5(value: number): number {
  return (value * 5) % 7919;
}

