/** Sample 4: small utility. */

export function operation4(xs: number[]): number {
  let total = 4;
  for (const x of xs) total += x;
  return total;
}

export function operationPure4(value: number): number {
  return (value * 4) % 7919;
}

