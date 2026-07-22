import { describe, expect, test } from 'vitest'

import { defineGroupProtocol, retentionOf } from '../src/protocol.js'

// Every procedure kind, declared the way a host declares one. These live at module
// scope so `test:types` checks them whether or not a test body runs: the defect
// these cover is a compile error, and a compile error inside a test body that is
// never reached still fails the type suite, but one at module scope fails it for
// the right reason.
const protocol = defineGroupProtocol({
  'room/typing': {
    type: 'event',
    data: { type: 'object' },
  },
  'room/said': {
    type: 'event',
    retain: 'ephemeral',
    data: { type: 'object' },
  },
  'room/posted': {
    type: 'event',
    retain: 'log',
    data: { type: 'object' },
  },
  'room/roster': {
    type: 'request',
    param: { type: 'object' },
    result: { type: 'object' },
  },
  'room/asked': {
    type: 'request',
    retain: 'ephemeral',
    param: { type: 'object' },
    result: { type: 'object' },
  },
})

describe('defineGroupProtocol', () => {
  // The regression. A request carrying no `retain` is the ordinary always-ephemeral
  // case, and it was rejected outright: the contextual type collapsed to
  // `{ retain?: never }`, so excess-property checking failed on `type` — a property
  // every procedure has. Nothing caught it, because the only request in the suite
  // sat under a `@ts-expect-error` meant for `retain`, which swallowed it whole.
  test('accepts a request procedure that declares no retention', () => {
    expect(retentionOf(protocol, 'room/roster')).toBe('ephemeral')
  })

  test('accepts an event with and without retention, and reports each', () => {
    expect(retentionOf(protocol, 'room/posted')).toBe('log')
    expect(retentionOf(protocol, 'room/typing')).toBe('ephemeral')
  })

  // Saying `ephemeral` and saying nothing are the same declaration, and a definition
  // that states its choice must not read differently from one that leaves the default.
  test('reads an explicit ephemeral the same as an omitted one, on both kinds', () => {
    expect(retentionOf(protocol, 'room/said')).toBe(retentionOf(protocol, 'room/typing'))
    expect(retentionOf(protocol, 'room/asked')).toBe(retentionOf(protocol, 'room/roster'))
    expect(retentionOf(protocol, 'room/said')).toBe('ephemeral')
    expect(retentionOf(protocol, 'room/asked')).toBe('ephemeral')
  })

  // `ephemeral` is the only retention correlated traffic has, so declaring it is legal
  // and must not trip the runtime guard — which fires on 'log' alone, not on any retain.
  test('accepts an explicit ephemeral on correlated traffic without throwing', () => {
    expect(() =>
      defineGroupProtocol({
        'room/ask': {
          type: 'request',
          retain: 'ephemeral',
          param: { type: 'object' },
          result: { type: 'object' },
        },
      }),
    ).not.toThrow()
  })

  test('returns the definition unchanged', () => {
    const definition = {
      'room/typing': { type: 'event', data: { type: 'object' } },
    } as const
    expect(defineGroupProtocol(definition)).toBe(definition)
  })

  // The guardrail the above must not have loosened. Retaining correlated traffic
  // would re-fire a responder on drain against an rid whose requester and timeout
  // are long dead, so it is refused twice over: the type rejects it, and the throw
  // catches a JS caller or an erased type that never met the type at all.
  test('refuses retention on a request, at the type level and at runtime', () => {
    expect(() =>
      defineGroupProtocol({
        // @ts-expect-error only 'event' procedures may declare retain
        'room/ask': {
          type: 'request',
          retain: 'log',
          param: { type: 'object' },
          result: { type: 'object' },
        },
      }),
    ).toThrow(/retain/)
  })

  test('refuses retention on a stream', () => {
    expect(() =>
      defineGroupProtocol({
        // @ts-expect-error only 'event' procedures may declare retain
        'room/feed': {
          type: 'stream',
          retain: 'log',
          param: { type: 'object' },
          receive: { type: 'object' },
          result: { type: 'object' },
        },
      }),
    ).toThrow(/retain/)
  })

  test('refuses retention on a channel', () => {
    expect(() =>
      defineGroupProtocol({
        // @ts-expect-error only 'event' procedures may declare retain
        'room/duplex': {
          type: 'channel',
          retain: 'log',
          param: { type: 'object' },
          send: { type: 'object' },
          receive: { type: 'object' },
          result: { type: 'object' },
        },
      }),
    ).toThrow(/retain/)
  })
})

describe('retentionOf', () => {
  test('treats an unknown procedure as ephemeral', () => {
    expect(retentionOf(protocol, 'room/absent')).toBe('ephemeral')
  })

  // `retain` is only meaningful on an event. A value smuggled onto another kind by
  // a JS caller must not be honoured by the reader either, or the two halves of the
  // guardrail could disagree about what a definition means.
  test('ignores retention smuggled onto a non-event', () => {
    const smuggled = {
      'room/ask': { type: 'request', retain: 'log', param: {}, result: {} },
    } as unknown as Parameters<typeof retentionOf>[0]
    expect(retentionOf(smuggled, 'room/ask')).toBe('ephemeral')
  })
})
