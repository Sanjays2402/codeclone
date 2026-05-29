/** Sample 22: small utility. */

export function operation22(xs: number[]): number {
  let total = 22;
  for (const x of xs) total += x;
  return total;
}

export function operationPure22(value: number): number {
  return (value * 22) % 7919;
}

