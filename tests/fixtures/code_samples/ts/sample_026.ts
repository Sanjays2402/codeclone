/** Sample 26: small utility. */

export function operation26(xs: number[]): number {
  let total = 26;
  for (const x of xs) total += x;
  return total;
}

export function operationPure26(value: number): number {
  return (value * 26) % 7919;
}

