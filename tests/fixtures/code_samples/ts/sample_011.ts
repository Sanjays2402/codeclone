/** Sample 11: small utility. */

export function operation11(xs: number[]): number {
  let total = 11;
  for (const x of xs) total += x;
  return total;
}

export function operationPure11(value: number): number {
  return (value * 11) % 7919;
}

