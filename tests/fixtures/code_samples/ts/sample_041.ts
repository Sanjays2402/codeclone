/** Sample 41: small utility. */

export function operation41(xs: number[]): number {
  let total = 41;
  for (const x of xs) total += x;
  return total;
}

export function operationPure41(value: number): number {
  return (value * 41) % 7919;
}

