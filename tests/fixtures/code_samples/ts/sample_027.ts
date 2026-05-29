/** Sample 27: small utility. */

export function operation27(xs: number[]): number {
  let total = 27;
  for (const x of xs) total += x;
  return total;
}

export function operationPure27(value: number): number {
  return (value * 27) % 7919;
}

