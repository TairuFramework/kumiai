import { expect, test, vi } from 'vitest'

import { enqueueOperation } from '../src/control/operations.js'
import type { Outcome } from '../src/control/types.js'
import { asLogPosition } from '../src/cursor.js'
import { OperationRejectedError } from '../src/errors.js'
import { FakeHub } from './fixtures/fake-hub.js'
import {
  buildInviteCommit,
  buildLedgerCommit,
  makeMLSPeer,
  seedBuiltOperation,
} from './fixtures/peer.js'

test('enqueueing the same ID preserves the original intent, sequence and deadline without writing', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71))
  try {
    await member.peer.replay()
    const deps = { control: member.control, now: () => 100, newID: () => crypto.randomUUID() }
    const request = buildLedgerCommit(member, ['first'])
    const original = await enqueueOperation(deps, request)
    const apply = vi.spyOn(member.control, 'apply')
    const duplicate = await enqueueOperation(
      { ...deps, now: () => 200 },
      { ...request, body: new Uint8Array([9]), revokes: true },
    )
    expect(duplicate).toEqual(original)
    expect((await member.control.load()).operations).toEqual([original])
    expect(apply).not.toHaveBeenCalled()
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('a settled public ID is reserved until its outcome is acknowledged', async () => {
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71))
  try {
    const request = buildLedgerCommit(member, [])
    await member.peer.commit(request)
    const outcome = (await member.peer.outcomes())[0]
    if (outcome === undefined) throw new Error('Missing settled outcome')
    expect(outcome.kind).toBe('landed')
    const before = await member.control.load()
    const apply = vi.spyOn(member.control, 'apply')
    await expect(member.peer.enqueue(request)).rejects.toBeInstanceOf(OperationRejectedError)
    expect(await member.control.load()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
    await member.peer.ack(outcome.id)
    const op = await enqueueOperation(
      { control: member.control, now: Date.now, newID: () => crypto.randomUUID() },
      request,
    )
    expect(op.id).toBe(request.id)
    expect((await member.control.load()).operations).toEqual([op])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test.each(['host-operation', 'kumiai/internal/rotation-retained'])(
  'any retained report reserves %s without a write',
  async (id) => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71))
    try {
      await member.peer.replay()
      const request = { ...buildLedgerCommit(member, []), id }
      const deps = { control: member.control, now: Date.now, newID: () => crypto.randomUUID() }
      for (const kind of ['unknown', 'lost', 'rejected', 'landed'] as const) {
        const outcome: Outcome = {
          id: `report-${kind}`,
          opID: id,
          at: 100,
          ...(kind === 'landed'
            ? { kind, position: asLogPosition('1') }
            : kind === 'rejected'
              ? { kind, reason: 'not eligible' }
              : { kind }),
        }
        await member.control.apply({ putOutcomes: [outcome] }, crypto.randomUUID())
        const before = await member.control.load()
        const apply = vi.spyOn(member.control, 'apply')
        await expect(enqueueOperation(deps, request)).rejects.toBeInstanceOf(OperationRejectedError)
        expect(await member.control.load()).toEqual(before)
        expect(apply).not.toHaveBeenCalled()
        apply.mockRestore()
        await member.control.apply({ deleteOutcomes: [outcome.id] }, crypto.randomUUID())
      }
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)

test('a live build and its acknowledged abandonment still reserve the operation ID', async () => {
  let enqueue!: (request: ReturnType<typeof buildLedgerCommit>) => Promise<void>
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71), {
    internalOperations: {
      bind: (capability) => {
        enqueue = capability.enqueue
      },
      onOutcome: () => {},
    },
  })
  try {
    await member.peer.replay()
    const request = { ...buildLedgerCommit(member, []), id: 'kumiai/internal/rotation-live' }
    await seedBuiltOperation(member, request)
    expect((await member.control.load()).operations).toEqual([])
    const before = await member.control.load()
    await expect(enqueue(request)).rejects.toBeInstanceOf(OperationRejectedError)
    expect(await member.control.load()).toEqual(before)
    await member.peer.abandon()
    await vi.waitFor(async () => expect((await member.control.load()).outcomes).toEqual([]))
    expect((await member.control.load()).spentSource).not.toBeNull()
    await expect(enqueue(request)).rejects.toBeInstanceOf(OperationRejectedError)
    expect((await member.control.load()).operations).toEqual([])
    const successor = { ...buildLedgerCommit(member, []), id: 'different-operation' }
    await member.peer.enqueue(successor)
    expect((await member.control.load()).operations).toMatchObject([{ id: successor.id }])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})

test('an acknowledged invite ID stays reserved while its Welcome remains owed', async () => {
  let deliveryAvailable = false
  const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(71), {
    deliverWelcome: async () => {
      if (!deliveryAvailable) throw new Error('Transport unavailable')
    },
  })
  try {
    const inviteA = buildInviteCommit(member, 'bob')
    await member.peer.commit(inviteA)
    const outcome = (await member.peer.outcomes()).find((row) => row.opID === inviteA.id)
    if (outcome === undefined) throw new Error('Missing invite outcome')
    expect(outcome.kind).toBe('landed')
    await member.peer.ack(outcome.id)
    const before = await member.control.load()
    expect(before.outcomes).toEqual([])
    expect(before.operations).toEqual([])
    expect(before.commitOnce).toBeNull()
    expect(before.spentSource).toBeNull()
    expect(before.welcomes).toMatchObject([{ opID: inviteA.id, recipients: ['bob'] }])
    const inviteB = { ...buildInviteCommit(member, 'carol'), id: inviteA.id }
    const apply = vi.spyOn(member.control, 'apply')
    await expect(member.peer.enqueue(inviteB)).rejects.toBeInstanceOf(OperationRejectedError)
    expect(await member.control.load()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
    apply.mockRestore()
    deliveryAvailable = true
    await vi.waitFor(async () => expect((await member.control.load()).welcomes).toEqual([]), {
      timeout: 3000,
    })
    const op = await enqueueOperation(
      { control: member.control, now: Date.now, newID: () => crypto.randomUUID() },
      inviteB,
    )
    expect(op.body).toEqual(inviteB.body)
    expect((await member.control.load()).operations).toEqual([op])
  } finally {
    await member.peer.dispose()
    await member.peer.drained()
  }
})
