import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import type { LogHub } from '@kumiai/hub-tunnel'
import { createGroup, encodeClientState, type GroupHandle } from '@kumiai/mls'
import {
  type AnchorStore,
  appFrameIdempotencyKey,
  bindAppCompletionCoverage,
  encodeAppAAD,
  type GroupCrypto,
  type GroupPeer,
  type GroupTransaction,
  type HandlerCompletion,
  type PendingAppFrame,
  protocolTopic,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createLedgerEntrySlot, type LedgerEntrySlot } from '../src/mls.js'
import { orderedCoverage } from './fixtures/handler-completion.js'

type TestHub = { connect(identity: OwnIdentity): LogHub; dispose(): Promise<void> }
type TestMember = {
  crypto: GroupCrypto
  peer: Pick<GroupPeer<Record<string, never>>, 'replay' | 'dispose'>
  anchorStore: AnchorStore
  appCursorStore: { stored(topicID: string): Promise<string | null> }
}
const { makeMember, createMemoryStateStore } = (await import(
  new URL('../../../tests/integration/test/app-lane-e2e.ts', import.meta.url).href
)) as {
  makeMember(params: {
    hub: TestHub
    identity: OwnIdentity
    group: GroupHandle
    entrySlot: LedgerEntrySlot
    durablePending?: boolean
  }): TestMember
  createMemoryStateStore(key: { groupID: string; incarnation: number }): unknown
}
const { createWireHub } = (await import(
  new URL('../../../tests/integration/test/log-hub-over-wire.ts', import.meta.url).href
)) as { createWireHub(): TestHub }

const { createMemberPersistence } = (await import(
  new URL('../../../tests/integration/test/member-persistence.ts', import.meta.url).href
)) as {
  createMemberPersistence(
    base: unknown,
    handle: GroupHandle,
    ledger: () => Array<string>,
  ): {
    completion: HandlerCompletion<GroupTransaction>
    cursor: { stored(topicID: string): Promise<string | null> }
    pending: {
      persistOpened(state: Uint8Array, record: PendingAppFrame): Promise<void>
      list(): Promise<Array<PendingAppFrame>>
    }
  }
}

test('member fixture supplies saved-frame delivery for retained handlers by default', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  const slot = createLedgerEntrySlot()
  const { group } = await createGroup(identity, 'default-saved-delivery', {
    resolveLedgerEntries: slot.resolve,
  })
  const member = makeMember({ hub, identity, group, entrySlot: slot })
  try {
    expect(member.crypto.pending).toBeDefined()
    expect(await member.crypto.pending?.list()).toEqual([])
  } finally {
    await member.peer.dispose()
    await hub.dispose()
  }
})

test('member fixture proves a fetched dead prefix into its durable cursor', async () => {
  const hub = createWireHub()
  const identity = randomIdentity()
  const slot = createLedgerEntrySlot()
  const { group } = await createGroup(identity, 'fixture-prefix-proof', {
    resolveLedgerEntries: slot.resolve,
  })
  const member = makeMember({ hub, identity, group, entrySlot: slot, durablePending: true })
  try {
    await member.peer.replay()
    const anchor = (await member.anchorStore.load())?.anchor
    if (anchor === undefined) throw new Error('Missing anchor')
    const topicID = protocolTopic(anchor.secret, anchor.epoch, 'chat')
    const payload = await member.crypto.wrap(encodeEventFrame('chat/posted', {}), {
      aad: encodeAppAAD({ topicID, intent: 'log' }),
    })
    payload[0] = 255
    payload[1] = 255
    const observerID = randomIdentity()
    const observer = hub.connect(observerID)
    await observer.subscribe(observerID.id, topicID)
    const sent = await observer.publish({
      senderDID: observerID.id,
      topicID,
      payload,
      retain: 'log',
    })
    await vi.waitFor(async () =>
      expect(await member.appCursorStore.stored(topicID)).toBe(sent.sequenceID),
    )
    expect(await member.crypto.pending?.list()).toEqual([])
  } finally {
    await member.peer.dispose()
    await hub.dispose()
  }
})

test('fixture completion preserves the cursor behind a held predecessor', async () => {
  const key = { groupID: 'fixture-held-prefix', incarnation: 1 }
  const { group } = await createGroup(randomIdentity(), key.groupID)
  const storage = createMemberPersistence(
    createMemoryStateStore(key),
    group,
    () => group.ledgerTokens,
  )
  const cursor = storage.cursor
  const frame = {
    ...key,
    id: 'later',
    topicID: 'chat',
    protocol: 'chat',
    procedure: 'posted',
    segment: 1,
    position: '2',
  }
  const record = {
    frame,
    payload: encodeEventFrame('posted', {}),
    epoch: 1,
    senderDID: randomIdentity().id,
    idempotencyKey: appFrameIdempotencyKey(frame),
  }
  await storage.pending.persistOpened(encodeClientState(group.state), record)
  const completion = storage.completion
  const coverage = orderedCoverage([{ frame: { ...frame, id: 'held', position: '1' } }, record])
  const binding = bindAppCompletionCoverage(completion, coverage.source)
  if (binding === undefined) throw new Error('Missing fixture completion coverage')
  try {
    await completion.complete(['later'])
    await binding.advance()
    expect(await storage.pending.list()).toEqual([])
    expect(await cursor.stored('chat')).toBeNull()
  } finally {
    binding.unbind()
  }
})

test('fixture completion ignores unknown IDs without writing a cursor', async () => {
  const key = { groupID: 'fixture-unknown-completion', incarnation: 1 }
  const { group } = await createGroup(randomIdentity(), key.groupID)
  const storage = createMemberPersistence(
    createMemoryStateStore(key),
    group,
    () => group.ledgerTokens,
  )
  const cursor = storage.cursor
  const completion = storage.completion
  const coverage = orderedCoverage(
    [
      {
        frame: { ...key, id: 'dead', topicID: 'chat', protocol: 'chat', segment: 1, position: '1' },
      },
    ],
    ['dead'],
  )
  const binding = bindAppCompletionCoverage(completion, coverage.source)
  if (binding === undefined) throw new Error('Missing fixture completion coverage')
  try {
    await completion.complete(['missing'])
    expect(await cursor.stored('chat')).toBeNull()
    await binding.advance()
    expect(await cursor.stored('chat')).toBe('1')
  } finally {
    binding.unbind()
  }
})
