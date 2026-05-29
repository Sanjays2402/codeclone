/** Sample 46: small utility. */

export function operation46(xs: number[]): number {
  let total = 46;
  for (const x of xs) total += x;
  return total;
}

export function operationPure46(value: number): number {
  return (value * 46) % 7919;
}

