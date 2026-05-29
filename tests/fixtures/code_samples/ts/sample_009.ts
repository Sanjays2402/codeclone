/** Sample 9: small utility. */

export function operation9(xs: number[]): number {
  let total = 9;
  for (const x of xs) total += x;
  return total;
}

export function operationPure9(value: number): number {
  return (value * 9) % 7919;
}

