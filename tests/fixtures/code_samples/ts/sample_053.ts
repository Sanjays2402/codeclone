/** Sample 53: small utility. */

export function operation53(xs: number[]): number {
  let total = 53;
  for (const x of xs) total += x;
  return total;
}

export function operationPure53(value: number): number {
  return (value * 53) % 7919;
}

