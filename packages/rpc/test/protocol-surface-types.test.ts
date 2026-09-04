import type { GatheredReply } from '@kumiai/broadcast'
import { expectTypeOf, test } from 'vitest'

import type { createGroupPeer, InternalSurface, ProtocolSurface } from '../src/peer.js'
import { defineGroupProtocol } from '../src/protocol.js'

// A file with no runtime test is a vitest suite failure ("No test suite found"), so this
// registers one; the type checking itself happens in `_protocolSurfaceTypes` below, which `tsc`
// checks but nothing ever calls.
test('protocol surface types (checked by tsc, not run)', () => {})

const chat = defineGroupProtocol({
  'chat/posted': {
    type: 'event',
    data: { type: 'object', properties: { text: { type: 'string' }, n: { type: 'number' } } },
  },
  'chat/ask': { type: 'request', param: { type: 'object' }, result: { type: 'string' } },
  // Typed param, so a wrong param field type is expressible.
  'chat/lookup': {
    type: 'request',
    param: { type: 'object', properties: { n: { type: 'number' } } },
    result: { type: 'string' },
  },
  // Absent-schema branches: no `data`, and no `param`/`result`. `DataOf<undefined>` = `never`,
  // `ReturnOf<undefined>` = `void`, so their configs are optional and the request result is void.
  'chat/ping': { type: 'event' },
  'chat/noop': { type: 'request' },
})
type Protocols = { chat: typeof chat }

// Finding 3: `ProtocolSurface` takes EXACTLY one type argument. Its `Events`/`Requests` defs maps
// live on a non-exported impl alias, so a caller cannot forge them. Passing extra args is an error.
// @ts-expect-error ProtocolSurface takes exactly one type argument; its defs maps are not caller-forgeable
type _Forged = ProtocolSurface<typeof chat, never, never>

// Never called at runtime; present only for `tsc` to check. Every `@ts-expect-error` fires only if
// the error below it is real — an unused directive is itself a compile error (TS2578).
async function _protocolSurfaceTypes(peer: ReturnType<typeof createGroupPeer<Protocols>>) {
  const chat = peer.protocol('chat')

  // dispatch: event names only, data under `data`
  await chat.dispatch('chat/posted', { data: { text: 'hi' } })
  // @ts-expect-error unknown procedure name
  await chat.dispatch('chat/nope', { data: {} })
  // @ts-expect-error dispatch rejects a request procedure
  await chat.dispatch('chat/ask', { data: {} })
  // @ts-expect-error wrong data field type
  await chat.dispatch('chat/posted', { data: { n: 'not a number' } })

  // request: request names only, typed result
  const answer = await chat.request('chat/ask', { param: {} })
  expectTypeOf(answer).toEqualTypeOf<string>()
  // options fold into the same config
  await chat.request('chat/ask', { param: {}, timeoutMs: 10 })
  // @ts-expect-error request rejects an event procedure
  await chat.request('chat/posted', { param: {} })
  // @ts-expect-error wrong param field type
  await chat.request('chat/lookup', { param: { n: 'x' } })

  // gather: typed replies
  const replies = await chat.gather('chat/ask', { param: {} })
  expectTypeOf(replies).toEqualTypeOf<Array<GatheredReply<string>>>()

  // Absent-schema event (`chat/ping` has no `data`): config is optional, a data payload rejected.
  await chat.dispatch('chat/ping')
  // @ts-expect-error no-data event rejects a data payload
  await chat.dispatch('chat/ping', { data: { x: 1 } })

  // Absent-schema request (`chat/noop` has no `param`/`result`): config optional, options-only OK,
  // a param rejected, result is void.
  await chat.request('chat/noop')
  await chat.request('chat/noop', { timeoutMs: 5 })
  // @ts-expect-error no-param request rejects a param
  await chat.request('chat/noop', { param: {} })
  const nores = await chat.request('chat/noop')
  expectTypeOf(nores).toEqualTypeOf<void>()
}

// Drift guard: if the internal shape `surfaceFor` builds against (`InternalSurface`, imported from
// `peer.ts` — the REAL type, not a copy, so a rename or dropped method in the source breaks this)
// diverges from the public `ProtocolSurface`, this stops compiling.
//
// What IS locked here, per config parameter pinned at one concrete procedure name (whole-function
// comparison is unusable for `dispatch`/`request`/`gather` — see below):
//   - dispatch/request/gather CONFIG PARAMETER shape: a renamed or reshaped config field breaks it.
//   - method PRESENCE: dropping a method from `InternalSurface` breaks the extraction (incl. `to`).
//   - `to`'s return SHAPE: the public `to` return must stay assignable to the internal `to` return
//     (`Promise<Client<...>>`), so `to` cannot be re-typed to something that is not a member client
//     at all (e.g. `Promise<void>`).
//
// What is NOT and CANNOT be locked here:
//   - the `request`/`gather` RESULT type. `InternalSurface` returns `Promise<unknown>`, and the real
//     `as ProtocolSurface<...>` cast in `peer.ts` (surfaceFor / the readiness wrapper) DELIBERATELY
//     widens that `unknown` to each call's `T['Result']`. A structural result assertion is therefore
//     vacuous one way (public `string` -> internal `unknown`, always true) and impossible the other
//     (internal `unknown` -> public `string`, always false), unrelated to drift. This test does NOT
//     catch wrong-result forwarding; that gap is exactly what the cast bridges, checked elsewhere by
//     runtime behavior.
//   - `to`'s PROTOCOL IDENTITY. The internal `to` returns the widest `Client<ProtocolDefinition>`,
//     and every `Client<P>` is assignable to it (Client is covariant in its protocol and every
//     protocol extends `ProtocolDefinition`), so the check above is vacuous as to WHICH protocol the
//     returned client is typed for — a mutation returning `Client<someOtherProtocol>` passes. The
//     reverse direction (internal -> public) is impossible even for the correct protocol (wide ->
//     narrow), so neither direction locks the protocol. This is the same covariance bridge as the
//     result case above; do not read the `to` check as pinning the protocol.
//
// Comparing only the config parameter (and `to`'s return shape) sidesteps the traps above while
// still catching a renamed or reshaped field and a dropped method.
type ConfigOf<F, Name extends string> = F extends (prc: Name, ...args: infer A) => unknown
  ? A[0]
  : never
type ReturnOfMethod<F> = F extends (...args: Array<never>) => infer R ? R : never

function _internalConformsToPublic(internal: InternalSurface) {
  type Public = ProtocolSurface<typeof chat>

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

  // `to`'s return SHAPE: the public `to` return must be assignable to the internal one, locking
  // that `to` still returns a `Promise<Client<...>>` (not e.g. `Promise<void>`) and that the method
  // is present. It does NOT lock the client's protocol identity — see the block comment above.
  const toReturn: ReturnOfMethod<typeof internal.to> = {} as ReturnOfMethod<Public['to']>
  void toReturn
}
