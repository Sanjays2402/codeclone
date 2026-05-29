/** Sample 6: small utility. */

export function operation6(xs: number[]): number {
  let total = 6;
  for (const x of xs) total += x;
  return total;
}

export function operationPure6(value: number): number {
  return (value * 6) % 7919;
}

