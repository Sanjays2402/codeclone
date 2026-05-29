/** Sample 38: small utility. */

export function operation38(xs: number[]): number {
  let total = 38;
  for (const x of xs) total += x;
  return total;
}

export function operationPure38(value: number): number {
  return (value * 38) % 7919;
}

