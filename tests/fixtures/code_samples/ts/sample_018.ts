/** Sample 18: small utility. */

export function operation18(xs: number[]): number {
  let total = 18;
  for (const x of xs) total += x;
  return total;
}

export function operationPure18(value: number): number {
  return (value * 18) % 7919;
}

