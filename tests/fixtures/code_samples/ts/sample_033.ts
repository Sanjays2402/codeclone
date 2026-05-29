/** Sample 33: small utility. */

export function operation33(xs: number[]): number {
  let total = 33;
  for (const x of xs) total += x;
  return total;
}

export function operationPure33(value: number): number {
  return (value * 33) % 7919;
}

