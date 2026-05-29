/** Sample 10: small utility. */

export function operation10(xs: number[]): number {
  let total = 10;
  for (const x of xs) total += x;
  return total;
}

export function operationPure10(value: number): number {
  return (value * 10) % 7919;
}

