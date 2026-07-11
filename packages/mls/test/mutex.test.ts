import { describe, expect, test } from 'vitest'

import { createMutex } from '../src/mutex.js'

describe('createMutex', () => {
  test('runs queued operations one at a time in call order', async () => {
    const mutex = createMutex()
    const log: Array<string> = []
    const op = (id: string, ms: number) =>
      mutex.run(async () => {
        log.push(`start-${id}`)
        await new Promise((r) => setTimeout(r, ms))
        log.push(`end-${id}`)
      })
    // b is enqueued after a but asked to finish sooner; FIFO must still order them.
    await Promise.all([op('a', 20), op('b', 1)])
    expect(log).toEqual(['start-a', 'end-a', 'start-b', 'end-b'])
  })

  test('returns each operation its own result', async () => {
    const mutex = createMutex()
    const [a, b] = await Promise.all([mutex.run(async () => 1), mutex.run(async () => 2)])
    expect([a, b]).toEqual([1, 2])
  })

  test('a rejecting operation surfaces to its caller and does not poison the queue', async () => {
    const mutex = createMutex()
    const boom = mutex.run(async () => {
      throw new Error('boom')
    })
    const after = mutex.run(async () => 'ok')
    await expect(boom).rejects.toThrow('boom')
    await expect(after).resolves.toBe('ok')
  })
})
