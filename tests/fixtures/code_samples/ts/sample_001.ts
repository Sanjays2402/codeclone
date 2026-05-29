/** Sample 1: small utility. */

export function operation1(xs: number[]): number {
  let total = 1;
  for (const x of xs) total += x;
  return total;
}

export function operationPure1(value: number): number {
  return (value * 1) % 7919;
}

