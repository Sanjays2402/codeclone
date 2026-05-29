/** Sample 31: small utility. */

export function operation31(xs: number[]): number {
  let total = 31;
  for (const x of xs) total += x;
  return total;
}

export function operationPure31(value: number): number {
  return (value * 31) % 7919;
}

