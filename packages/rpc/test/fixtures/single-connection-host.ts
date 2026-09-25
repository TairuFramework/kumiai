import type { PendingAppFrame } from '../../src/crypto.js'

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A one-connection host store. A transaction owns its connection until its callback settles. */
export function createSingleConnectionHost() {
  let tail: Promise<unknown> = Promise.resolve()
  let active = 0
  let maximum = 0
  let version = 0
  let nextOpenVersion = 2
  let state = new Uint8Array([0])
  let attempts = 0
  const writes: Array<string> = []
  const rows = new Map<string, PendingAppFrame>()

  const transaction = <T>(work: () => Promise<T> | T): Promise<T> => {
    const operation = tail.then(async () => {
      active += 1
      maximum = Math.max(maximum, active)
      try {
        return await work()
      } finally {
        active -= 1
      }
    })
    tail = operation.catch(() => {})
    return operation
  }

  const pending = {
    async persistOpened(stagedState: Uint8Array, record: PendingAppFrame) {
      attempts += 1
      const openedVersion = nextOpenVersion++
      await transaction(() => {
        // One atomic write: the spent-key handle state and its delivery record.
        if (version >= openedVersion) throw new Error('staged state is stale')
        state = stagedState.slice()
        version = openedVersion
        rows.set(record.frame.id, record)
        writes.push('opened')
      })
    },
    list: () => transaction(() => [...rows.values()]),
    complete: (id: string) => transaction(() => void rows.delete(id)),
  }

  return {
    transaction,
    pending,
    // This save was issued before the open but is still in flight when the app frame arrives.
    saveEarlierState: (release: Promise<void>) =>
      transaction(async () => {
        await release
        if (version >= 1) throw new Error('earlier save is stale')
        state = new Uint8Array([1])
        version = 1
        writes.push('earlier')
      }),
    // A callback from an old save may arrive after the open. Reject it at the same epoch.
    saveStaleState: () =>
      transaction(() => {
        if (version >= 1) return false
        state = new Uint8Array([1])
        version = 1
        return true
      }),
    savedState: () => state.slice(),
    savedVersion: () => version,
    records: () => [...rows.values()],
    persistAttempts: () => attempts,
    maxConcurrentCalls: () => maximum,
    writeOrder: () => [...writes],
  }
}
