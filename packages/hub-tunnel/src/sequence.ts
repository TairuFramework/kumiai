/**
 * Whether hub sequence ID `a` precedes `b`. A hub mints them from one counter across topics,
 * fixed-width and zero-padded, so they compare as strings; a pair of plain decimals of differing
 * width compares by value.
 */
export function precedesSequenceID(a: string, b: string): boolean {
  if (a.length !== b.length && /^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b)
  return a < b
}
