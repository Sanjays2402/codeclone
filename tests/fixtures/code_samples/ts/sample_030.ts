/** Sample 30: small utility. */

export function operation30(xs: number[]): number {
  let total = 30;
  for (const x of xs) total += x;
  return total;
}

export function operationPure30(value: number): number {
  return (value * 30) % 7919;
}

