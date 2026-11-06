import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createMemoryBus } from '../src/bus.js'

describe('createMemoryBus', () => {
  test('fans a publish out to all subscribers of the topic', () => {
    const bus = createMemoryBus()
    const a: Array<string> = []
    const b: Array<string> = []
    bus.subscribe({ topicID: 't1', onMessage: (p) => a.push(new TextDecoder().decode(p)) })
    bus.subscribe({ topicID: 't1', onMessage: (p) => b.push(new TextDecoder().decode(p)) })

    bus.publish({ topicID: 't1', payload: fromUTF('hello') })

    expect(a).toEqual(['hello'])
    expect(b).toEqual(['hello'])
  })

  test('does not deliver across topics', () => {
    const bus = createMemoryBus()
    const received: Array<string> = []
    bus.subscribe({ topicID: 't1', onMessage: (p) => received.push(new TextDecoder().decode(p)) })

    bus.publish({ topicID: 't2', payload: fromUTF('nope') })

    expect(received).toEqual([])
  })

  test('unsubscribe stops delivery', () => {
    const bus = createMemoryBus()
    const received: Array<string> = []
    const unsub = bus.subscribe({
      topicID: 't1',
      onMessage: (p) => received.push(new TextDecoder().decode(p)),
    })

    bus.publish({ topicID: 't1', payload: fromUTF('first') })
    unsub()
    bus.publish({ topicID: 't1', payload: fromUTF('second') })

    expect(received).toEqual(['first'])
  })
})
