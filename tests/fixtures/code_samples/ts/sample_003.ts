/** Sample 3: small utility. */

export function operation3(xs: number[]): number {
  let total = 3;
  for (const x of xs) total += x;
  return total;
}

export function operationPure3(value: number): number {
  return (value * 3) % 7919;
}

