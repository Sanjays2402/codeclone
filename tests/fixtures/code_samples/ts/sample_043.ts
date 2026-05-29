/** Sample 43: small utility. */

export function operation43(xs: number[]): number {
  let total = 43;
  for (const x of xs) total += x;
  return total;
}

export function operationPure43(value: number): number {
  return (value * 43) % 7919;
}

