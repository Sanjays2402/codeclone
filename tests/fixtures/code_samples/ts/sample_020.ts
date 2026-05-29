/** Sample 20: small utility. */

export function operation20(xs: number[]): number {
  let total = 20;
  for (const x of xs) total += x;
  return total;
}

export function operationPure20(value: number): number {
  return (value * 20) % 7919;
}

