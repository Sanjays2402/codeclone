/** Sample 19: small utility. */

export function operation19(xs: number[]): number {
  let total = 19;
  for (const x of xs) total += x;
  return total;
}

export function operationPure19(value: number): number {
  return (value * 19) % 7919;
}

