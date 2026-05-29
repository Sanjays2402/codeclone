/** Sample 50: small utility. */

export function operation50(xs: number[]): number {
  let total = 50;
  for (const x of xs) total += x;
  return total;
}

export function operationPure50(value: number): number {
  return (value * 50) % 7919;
}

