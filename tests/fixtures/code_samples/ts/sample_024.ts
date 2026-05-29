/** Sample 24: small utility. */

export function operation24(xs: number[]): number {
  let total = 24;
  for (const x of xs) total += x;
  return total;
}

export function operationPure24(value: number): number {
  return (value * 24) % 7919;
}

