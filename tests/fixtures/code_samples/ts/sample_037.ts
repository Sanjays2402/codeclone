/** Sample 37: small utility. */

export function operation37(xs: number[]): number {
  let total = 37;
  for (const x of xs) total += x;
  return total;
}

export function operationPure37(value: number): number {
  return (value * 37) % 7919;
}

