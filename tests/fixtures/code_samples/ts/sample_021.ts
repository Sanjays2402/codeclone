/** Sample 21: small utility. */

export function operation21(xs: number[]): number {
  let total = 21;
  for (const x of xs) total += x;
  return total;
}

export function operationPure21(value: number): number {
  return (value * 21) % 7919;
}

