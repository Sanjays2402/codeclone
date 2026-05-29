/** Sample 28: small utility. */

export function operation28(xs: number[]): number {
  let total = 28;
  for (const x of xs) total += x;
  return total;
}

export function operationPure28(value: number): number {
  return (value * 28) % 7919;
}

