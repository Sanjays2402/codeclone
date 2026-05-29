/** Sample 16: small utility. */

export function operation16(xs: number[]): number {
  let total = 16;
  for (const x of xs) total += x;
  return total;
}

export function operationPure16(value: number): number {
  return (value * 16) % 7919;
}

