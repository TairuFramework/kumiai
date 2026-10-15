export function createMonotoneClock(): () => number {
  let previous = Number.NEGATIVE_INFINITY
  return () => {
    previous = Math.max(previous, Date.now())
    return previous
  }
}
