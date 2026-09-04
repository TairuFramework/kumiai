import type { GatheredReply } from '@kumiai/broadcast'
import { expectTypeOf, test } from 'vitest'

import type { createGroupPeer } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'

// A file with no runtime test is a vitest suite failure ("No test suite found"), so this
// registers one; the type checking itself happens in `_protocolSurfaceTypes` below, which `tsc`
// checks but nothing ever calls.
test('protocol surface types (checked by tsc, not run)', () => {})

const chat = defineGroupProtocol({
  'chat/posted': {
    type: 'event',
    data: { type: 'object', properties: { text: { type: 'string' } } },
  },
  'chat/ask': { type: 'request', param: { type: 'object' }, result: { type: 'string' } },
})
type Protocols = { chat: typeof chat }

// Never called at runtime; present only for `tsc` to check.
async function _protocolSurfaceTypes(peer: ReturnType<typeof createGroupPeer<Protocols>>) {
  const chat = peer.protocol('chat')

  // dispatch: event names only, data under `data`
  await chat.dispatch('chat/posted', { data: { text: 'hi' } })
  // @ts-expect-error unknown procedure name
  await chat.dispatch('chat/nope', { data: {} })
  // @ts-expect-error dispatch rejects a request procedure
  await chat.dispatch('chat/ask', { data: {} })

  // request: request names only, typed result
  const answer = await chat.request('chat/ask', { param: {} })
  expectTypeOf(answer).toEqualTypeOf<string>()
  // options fold into the same config
  await chat.request('chat/ask', { param: {}, timeoutMs: 10 })
  // @ts-expect-error request rejects an event procedure
  await chat.request('chat/posted', { param: {} })

  // gather: typed replies
  const replies = await chat.gather('chat/ask', { param: {} })
  expectTypeOf(replies).toEqualTypeOf<Array<GatheredReply<string>>>()
}

// If the internal shape `surfaceFor` builds against drifts from the public surface — a renamed
// or reshaped config field, a dropped method — this stops compiling. `InternalSurface` is not
// exported, so this is a local structural copy of its shape (see `peer.ts`) rather than an
// import.
//
// Compared per-CONFIG-PARAMETER, pinned at one concrete procedure name, rather than as whole
// function types: `request`/`gather`'s internal `unknown` result can never be plainly assignable
// to the public surface's per-call generic `T['Result']` (that gap is exactly what the real
// `as ProtocolSurface<Protocols[K]>` cast in `peer.ts` bridges), so a whole-function-type
// assignment always fails there for a reason unrelated to drift; and a whole-object `as` cast
// always trivially succeeds in the other direction (a wider public shape structurally satisfies a
// narrower assumed-internal one), so it can silently pass a genuinely reshaped or dropped field.
// Extracting just the config type at 'chat/posted' / 'chat/ask' sidesteps both traps and still
// catches a renamed or reshaped field.
type ConfigOf<F, Name extends string> = F extends (prc: Name, ...args: infer A) => unknown
  ? A[0]
  : never

function _internalConformsToPublic(internal: {
  dispatch: (prc: string, config?: { data?: Record<string, unknown> }) => Promise<void>
  request: (
    prc: string,
    config?: { param?: unknown } & { errorThreshold?: number; timeoutMs?: number },
  ) => Promise<unknown>
  gather: (
    prc: string,
    config?: { param?: unknown } & { quorum?: number; timeoutMs?: number },
  ) => Promise<Array<GatheredReply>>
}) {
  type Public = import('../src/peer.js').ProtocolSurface<typeof chat>

  // Checked public-config-assignable-to-internal-config, not the reverse: `InternalSurface` is
  // deliberately WIDER (its config is unconditionally optional; the public surface tightens
  // per-procedure, e.g. `chat/posted` carries a payload so its config is required, not optional).
  // What must hold is that every value a public caller may pass is one the internal
  // implementation accepts.
  const dispatchConfig: ConfigOf<typeof internal.dispatch, 'chat/posted'> = {} as ConfigOf<
    Public['dispatch'],
    'chat/posted'
  >
  void dispatchConfig
  const requestConfig: ConfigOf<typeof internal.request, 'chat/ask'> = {} as ConfigOf<
    Public['request'],
    'chat/ask'
  >
  void requestConfig
  const gatherConfig: ConfigOf<typeof internal.gather, 'chat/ask'> = {} as ConfigOf<
    Public['gather'],
    'chat/ask'
  >
  void gatherConfig
}
