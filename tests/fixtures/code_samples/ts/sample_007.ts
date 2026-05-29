/** Sample 7: small utility. */

export function operation7(xs: number[]): number {
  let total = 7;
  for (const x of xs) total += x;
  return total;
}

export function operationPure7(value: number): number {
  return (value * 7) % 7919;
}

