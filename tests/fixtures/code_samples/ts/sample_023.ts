/** Sample 23: small utility. */

export function operation23(xs: number[]): number {
  let total = 23;
  for (const x of xs) total += x;
  return total;
}

export function operationPure23(value: number): number {
  return (value * 23) % 7919;
}

