/** Sample 45: small utility. */

export function operation45(xs: number[]): number {
  let total = 45;
  for (const x of xs) total += x;
  return total;
}

export function operationPure45(value: number): number {
  return (value * 45) % 7919;
}

