import { expectTypeOf, test } from 'vitest'

import type {
  AppFrameRef,
  GroupPeerParams,
  GroupProcedureHandlers,
  GroupTransaction,
  HandlerCompletion,
  OpenAppInput,
  OpenAppResult,
  PendingAppFrame,
  PreOpenAppFrameRef,
  RecoveryCompletion,
} from '../src/index.js'
import { defineGroupProtocol } from '../src/protocol.js'

const protocol = defineGroupProtocol({
  posted: {
    type: 'event',
    retain: 'log',
    data: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  typing: {
    type: 'event',
    retain: 'ephemeral',
    data: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  ping: { type: 'event' },
  ask: { type: 'request', param: { type: 'string' }, result: { type: 'string' } },
  watch: { type: 'stream', receive: { type: 'string' } },
  chat: { type: 'channel', send: { type: 'string' }, receive: { type: 'string' } },
})
type Transaction = GroupTransaction & { put(value: string): Promise<void> }
type Handlers = GroupProcedureHandlers<typeof protocol, Transaction>

// Type witnesses run through test:types; their bodies need no live peer.
test('pre-open refs exclude procedure and opened refs require origin', () => {})
function _frames(pre: PreOpenAppFrameRef, opened: PendingAppFrame, result: OpenAppResult) {
  const input: OpenAppInput = { frame: pre, ciphertext: new Uint8Array() }
  expectTypeOf(input.frame).toEqualTypeOf<PreOpenAppFrameRef>()
  expectTypeOf(opened.frame.procedure).toEqualTypeOf<string>()
  expectTypeOf(opened.epoch).toEqualTypeOf<number>()
  expectTypeOf(opened.idempotencyKey).toEqualTypeOf<string>()
  const originless = { id: 'frame', protocol: 'chat', topicID: 'topic', segment: 1, position: '1' }
  // @ts-expect-error pre-open references require the group origin
  const missingOrigin: PreOpenAppFrameRef = originless
  // @ts-expect-error pre-open references have no authenticated procedure
  const premature: PreOpenAppFrameRef = { ...pre, procedure: 'posted' }
  // @ts-expect-error opened references require the authenticated procedure
  const missingProcedure: AppFrameRef = pre
  // @ts-expect-error opened records require epoch and idempotency key
  const incomplete: PendingAppFrame = {
    frame: opened.frame,
    payload: opened.payload,
    senderDID: opened.senderDID,
  }
  if (result.kind === 'opened') expectTypeOf(result.handleEpoch).toEqualTypeOf<number>()
  return { missingOrigin, premature, missingProcedure, incomplete }
}

test('transactional policy is available only on retained events', () => {})
const _transactional: Handlers['posted'] = {
  mode: 'transactional',
  async handle(context) {
    expectTypeOf(context.tx).toEqualTypeOf<Transaction>()
    expectTypeOf(context.data.text).toEqualTypeOf<string>()
    expectTypeOf(context.frame).toEqualTypeOf<AppFrameRef>()
    expectTypeOf(context.idempotencyKey).toEqualTypeOf<string>()
    expectTypeOf(context.epoch).toEqualTypeOf<number>()
    expectTypeOf(context.incarnation).toEqualTypeOf<number>()
    await context.tx.put(context.data.text)
  },
}
const _legacy: Handlers['posted'] = (context) => {
  expectTypeOf(context.frame).toEqualTypeOf<AppFrameRef | undefined>()
  expectTypeOf(context.epoch).toEqualTypeOf<number>()
}
const _policy = { mode: 'transactional' as const, handle: async () => {} }
// @ts-expect-error ephemeral events refuse transactional declarations
const _typing: Handlers['typing'] = _policy
// @ts-expect-error default events refuse transactional declarations
const _ping: Handlers['ping'] = _policy
// @ts-expect-error requests refuse transactional declarations
const _ask: Handlers['ask'] = _policy
// @ts-expect-error streams refuse transactional declarations
const _watch: Handlers['watch'] = _policy
// @ts-expect-error channels refuse transactional declarations
const _chat: Handlers['chat'] = _policy

test('recovery and handler completion occupy distinct fields', () => {})
function _completion(
  params: Extract<GroupPeerParams<{ chat: typeof protocol }, Transaction>, { mls: object }>,
  completion: HandlerCompletion<Transaction>,
  recoveryCompletion: RecoveryCompletion,
) {
  expectTypeOf(params.completion).toEqualTypeOf<HandlerCompletion<Transaction>>()
  expectTypeOf(params.recoveryCompletion).toEqualTypeOf<RecoveryCompletion | null | undefined>()
  const both: typeof params = { ...params, completion, recoveryCompletion, mls: params.mls }
  const withoutMLS: GroupPeerParams<{ chat: typeof protocol }, Transaction> = {
    hub: params.hub,
    crypto: params.crypto,
    localDID: params.localDID,
    protocols: params.protocols,
    handlers: params.handlers,
    completion,
  }
  // @ts-expect-error handler completion is required even without MLS
  const missing: GroupPeerParams<{ chat: typeof protocol }, Transaction> = {
    hub: params.hub,
    crypto: params.crypto,
    localDID: params.localDID,
    protocols: params.protocols,
    handlers: params.handlers,
  }
  return { both, withoutMLS, missing }
}
