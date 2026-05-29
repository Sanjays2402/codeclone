/** Sample 42: small utility. */

export function operation42(xs: number[]): number {
  let total = 42;
  for (const x of xs) total += x;
  return total;
}

export function operationPure42(value: number): number {
  return (value * 42) % 7919;
}

