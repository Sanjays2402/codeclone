/** Sample 57: small utility. */

export function operation57(xs: number[]): number {
  let total = 57;
  for (const x of xs) total += x;
  return total;
}

export function operationPure57(value: number): number {
  return (value * 57) % 7919;
}

