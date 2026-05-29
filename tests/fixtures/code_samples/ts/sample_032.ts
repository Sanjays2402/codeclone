/** Sample 32: small utility. */

export function operation32(xs: number[]): number {
  let total = 32;
  for (const x of xs) total += x;
  return total;
}

export function operationPure32(value: number): number {
  return (value * 32) % 7919;
}

