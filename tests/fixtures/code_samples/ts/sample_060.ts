/** Sample 60: small utility. */

export function operation60(xs: number[]): number {
  let total = 60;
  for (const x of xs) total += x;
  return total;
}

export function operationPure60(value: number): number {
  return (value * 60) % 7919;
}

