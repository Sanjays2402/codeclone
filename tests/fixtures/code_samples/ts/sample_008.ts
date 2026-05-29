/** Sample 8: small utility. */

export function operation8(xs: number[]): number {
  let total = 8;
  for (const x of xs) total += x;
  return total;
}

export function operationPure8(value: number): number {
  return (value * 8) % 7919;
}

