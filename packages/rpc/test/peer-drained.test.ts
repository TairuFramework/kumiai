import type { GatherOptions } from '@kumiai/broadcast'
import { BroadcastClient } from '@kumiai/broadcast'
import { describe, expect, test, vi } from 'vitest'

import { PeerDisposedError } from '../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../src/handshake.js'
import { createGroupPeer } from '../src/peer.js'
import { encodeLedgerRequest, encodeRecoveryRequest } from '../src/recovery.js'
import { rendezvousTopic } from '../src/topic.js'
import { createMemoryAnchorStore } from './fixtures/anchor.js'
import { createMemoryAppCursorStore } from './fixtures/app-cursor.js'
import { createFakeCrypto } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { createMemoryCommitJournal } from './fixtures/journal.js'
import { createMemoryGroupMLS } from './fixtures/memory-group-mls.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

function gate() {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function pausedDrain(peer: { drained(): Promise<void> }) {
  let drainSettledWhileHostPaused = false
  const promise = peer.drained().then(() => {
    drainSettledWhileHostPaused = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(drainSettledWhileHostPaused).toBe(false)
  return { promise }
}

describe('peer host drain', () => {
  test('drainedWaitsForInFlightJournalPut', async () => {
    for (const path of ['build', 'journal.put', 'onAccepted']) {
      const pause = gate()
      const journal = createMemoryCommitJournal()
      let entered = false
      let hostCallsAfterDispose = 0
      let disposed = false
      const put = journal.put
      journal.put = async (entry) => {
        if (disposed) hostCallsAfterDispose++
        if (path === 'journal.put') {
          entered = true
          await pause.promise
        }
        return put(entry)
      }
      const clear = journal.clear
      journal.clear = async (id) => {
        if (disposed) hostCallsAfterDispose++
        return clear(id)
      }
      const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0x73), { journal })
      const build = buildLedgerCommit(member, ['role:alice=member'])
      const operation = member.peer.commit(async () => {
        if (path === 'build') {
          entered = true
          await pause.promise
        }
        const pending = await build()
        return {
          ...pending,
          onAccepted: async () => {
            if (disposed) hostCallsAfterDispose++
            if (path === 'onAccepted') {
              entered = true
              await pause.promise
            }
            await pending.onAccepted()
          },
        }
      })
      const owned = operation.catch(() => {})
      await vi.waitFor(() => expect(entered).toBe(true))
      disposed = true
      await member.peer.dispose()
      const drain = await pausedDrain(member.peer)
      pause.release()
      await drain.promise
      await owned
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(hostCallsAfterDispose).toBe(0)
    }
  })

  test('drainedWaitsForAbandonedPortPromise', async () => {
    const pause = gate()
    let entered = false
    let hostCallsAfterDispose = 0
    let disposed = false
    const pending = {
      persistOpened: async () => {
        if (disposed) hostCallsAfterDispose++
      },
      complete: async () => {
        if (disposed) hostCallsAfterDispose++
      },
      list: async () => {
        if (disposed) hostCallsAfterDispose++
        entered = true
        await pause.promise
        return []
      },
    }
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice', pending })
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0x71), { crypto })
    await vi.waitFor(() => expect(entered).toBe(true))
    disposed = true
    await member.peer.dispose()
    const drain = await pausedDrain(member.peer)
    pause.release()
    await drain.promise
    expect(hostCallsAfterDispose).toBe(0)
  })

  test.each(['anchorStore.load', 'anchorStore.save', 'crypto.exportSecret'])(
    'drains paused construction %s',
    async (path) => {
      const pause = gate()
      let entered = false
      const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
      const anchorStore = createMemoryAnchorStore()
      if (path === 'anchorStore.load') {
        const load = anchorStore.load
        anchorStore.load = async () => {
          entered = true
          await pause.promise
          return load()
        }
      } else if (path === 'anchorStore.save') {
        const save = anchorStore.save
        anchorStore.save = async (...args) => {
          entered = true
          await pause.promise
          return save(...args)
        }
      } else {
        const exportSecret = crypto.exportSecret
        crypto.exportSecret = async (...args) => {
          entered = true
          await pause.promise
          return exportSecret(...args)
        }
      }
      const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0x72), {
        crypto,
        anchorStore,
      })
      await vi.waitFor(() => expect(entered).toBe(true))
      await member.peer.dispose()
      const drain = await pausedDrain(member.peer)
      pause.release()
      await drain.promise
    },
  )

  test('drains a cursor write after delivering a retained event', async () => {
    const pause = gate()
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x7b)
    const appCursorStore = createMemoryAppCursorStore()
    const save = appCursorStore.save
    let entered = false
    let delivered = 0
    let disposed = false
    let hostCallsAfterDispose = 0
    appCursorStore.save = async (...args) => {
      if (disposed) hostCallsAfterDispose++
      entered = true
      await pause.promise
      return save(...args)
    }
    const bob = makeMLSPeer(hub, 'bob', secret, {
      appCursorStore,
      handlers: {
        'chat/posted': () => {
          delivered++
        },
      },
    })
    const alice = makeMLSPeer(hub, 'alice', secret)
    try {
      await alice.peer
        .protocol('chat')
        .dispatch('chat/posted', { data: { text: 'durable cursor' } })
      await vi.waitFor(() => expect(entered).toBe(true))
      disposed = true
      await bob.peer.dispose()
      const drain = await pausedDrain(bob.peer)
      pause.release()
      await drain.promise
      expect(delivered).toBe(1)
      expect(hostCallsAfterDispose).toBe(0)
    } finally {
      pause.release()
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
      await Promise.all([alice.peer.drained(), bob.peer.drained()])
    }
  })

  test('drains a ledger opener abandoned by its recovery gather', async () => {
    const pause = gate()
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x74)
    const members = ['alice', 'bob']
    const recovery = { timeoutMs: 1000, getDelayMs: () => 0, deadlineMs: 3000 }
    const bob = makeMLSPeer(hub, 'bob', secret, { members, recovery })
    await bob.peer.commit(buildLedgerCommit(bob, ['role:bob=member']))
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({
      recoverySecret: secret,
      epoch: 1,
      localDID: 'alice',
      members,
      onAdvance: (epoch) => crypto.setEpoch(epoch),
    })
    let entered = false
    const open = mls.openSealedLedger
    mls.openSealedLedger = async (...args) => {
      entered = true
      await pause.promise
      return open(...args)
    }
    const alice = makeMLSPeer(hub, 'alice', secret, { crypto, mls, members, recovery })
    const recovering = alice.peer.recover().catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    await alice.peer.dispose()
    await recovering
    const drain = await pausedDrain(alice.peer)
    pause.release()
    await drain.promise
    await bob.peer.dispose()
  })

  test('drainedWaitsForReturnedRecoveryAdoption', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x36)
    const pause = gate()
    const members = ['alice', 'bob']
    const recovery = { timeoutMs: 60, deadlineMs: 600, getDelayMs: () => 0 }
    const alice = makeMLSPeer(hub, 'alice', secret, { members, recovery })
    const bob = makeMLSPeer(hub, 'bob', secret, { members, recovery })
    const apply = bob.mls.applyRecovery.bind(bob.mls)
    let accepting = false
    bob.mls.applyRecovery = async (...args) => {
      const pending = await apply(...args)
      if (pending == null || 'renewalRequired' in pending) return pending
      return {
        ...pending,
        onAccepted: async () => {
          accepting = true
          await pause.promise
          await pending.onAccepted()
        },
      }
    }
    const recovering = bob.peer.recover().catch(() => {})
    try {
      await vi.waitFor(() => expect(accepting).toBe(true))
      await bob.peer.dispose()
      const drain = await pausedDrain(bob.peer)
      pause.release()
      await drain.promise
      await recovering
    } finally {
      pause.release()
      await Promise.all([alice.peer.dispose(), bob.peer.dispose()])
    }
  })

  test.each(['crypto.unwrap', 'handler', 'gather.onReply'])(
    'drains paused %s and refuses a later reply observer',
    async (path) => {
      const pause = gate()
      const hub = new FakeHub()
      const chat = {
        'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'string' } },
      } as const
      let entered = false
      let observerCalls = 0
      const crypto = createFakeCrypto({ epoch: 1, localDID: 'bob' })
      let armed = false
      const unwrap = crypto.unwrap
      crypto.unwrap = async (...args) => {
        if (armed && path === 'crypto.unwrap') {
          entered = true
          await pause.promise
        }
        return unwrap(...args)
      }
      const bob = createGroupPeer({
        hub,
        crypto,
        localDID: 'bob',
        protocols: { chat },
        handlers: {
          chat: {
            'chat/echo': async () => {
              if (path === 'handler') {
                entered = true
                await pause.promise
              }
              return 'hello'
            },
          },
        },
      })
      const alice = createGroupPeer({
        hub,
        crypto: createFakeCrypto({ epoch: 1, localDID: 'alice' }),
        localDID: 'alice',
        protocols: { chat },
        handlers: { chat: { 'chat/echo': () => 'alice' } },
      })
      const controller = new AbortController()
      let deliveredObserver: GatherOptions['onReply']
      const gather = BroadcastClient.prototype.gather
      const capture = vi.spyOn(BroadcastClient.prototype, 'gather').mockImplementation(function (
        this: BroadcastClient,
        prc,
        prm,
        options,
      ) {
        deliveredObserver = options?.onReply
        return gather.call(this, prc, prm, options)
      })
      try {
        await new Promise((resolve) => setTimeout(resolve, 30))
        armed = true
        const gathering = alice.protocol('chat').gather('chat/echo', {
          param: {},
          quorum: 1,
          timeoutMs: 1000,
          signal: controller.signal,
          onReply: async () => {
            observerCalls++
            if (path === 'gather.onReply') {
              entered = true
              await pause.promise
            }
          },
        })
        await vi.waitFor(() => expect(entered).toBe(true))
        controller.abort()
        const owner = path === 'gather.onReply' ? alice : bob
        await owner.dispose()
        const drain = await pausedDrain(owner)
        pause.release()
        await drain.promise
        await gathering.catch(() => {})
        await alice.dispose()
        await alice.drained()
        const before = observerCalls
        expect(() => deliveredObserver?.({ senderDID: 'bob', value: 'late' })).toThrow(
          PeerDisposedError,
        )
        expect(observerCalls).toBe(before)
      } finally {
        pause.release()
        capture.mockRestore()
        await Promise.all([alice.dispose(), bob.dispose()])
        await Promise.all([alice.drained(), bob.drained()])
      }
    },
  )

  test('portCallAfterDisposeRejects', async () => {
    const pause = gate()
    const hub = new FakeHub()
    const journal = createMemoryCommitJournal()
    const markAccepted = journal.markAccepted
    let entered = false
    journal.markAccepted = async (...args) => {
      entered = true
      await pause.promise
      return markAccepted(...args)
    }
    const member = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(0x76), { journal })
    const readEpoch = vi.spyOn(member.mls, 'readEpoch')
    const pending = await buildLedgerCommit(member, ['role:alice=member'])()
    const onAccepted = vi.spyOn(pending, 'onAccepted')
    const operation = member.peer.commit(async () => pending)
    const owned = operation.catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    const readsBeforeDispose = readEpoch.mock.calls.length
    await member.peer.dispose()
    const drain = await pausedDrain(member.peer)
    pause.release()
    await expect(operation).rejects.toBeInstanceOf(PeerDisposedError)
    await owned
    await drain.promise
    expect(readEpoch).toHaveBeenCalledTimes(readsBeforeDispose)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(journal.slot()).not.toBeNull()
    const replacement = makeMLSPeer(hub, 'alice', new Uint8Array(32).fill(0x76), {
      restartOf: member,
    })
    await replacement.peer.replay()
    expect(journal.slot()).toBeNull()
    expect(member.mls.epoch()).toBe(2)
    expect(await member.mls.getLedger()).toEqual(['role:alice=member'])
    await replacement.peer.dispose()
    await replacement.peer.drained()
  })

  test('portCallAfterDisposeRejects: replacement replays the outbox entry', async () => {
    const pause = gate()
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x76)
    const journal = createMemoryCommitJournal()
    const markAccepted = journal.markAccepted
    let entered = false
    journal.markAccepted = async (...args) => {
      entered = true
      await pause.promise
      return markAccepted(...args)
    }
    const member = makeMLSPeer(hub, 'alice', secret, { journal })
    await member.peer.protocol('chat').dispatch('chat/posted', { data: { text: 'survived' } })
    const operation = member.peer.commit(buildLedgerCommit(member, ['proof']), {
      holdLogSends: true,
    })
    const observed = operation.catch(() => {})
    await vi.waitFor(() => expect(entered).toBe(true))
    await member.peer.dispose()
    const drain = await pausedDrain(member.peer)
    pause.release()
    await expect(operation).rejects.toBeInstanceOf(PeerDisposedError)
    await observed
    await drain.promise
    expect(await member.appOutbox.list()).toHaveLength(1)
    expect(journal.slot()?.holdsLogSends).toBe(true)
    const replacement = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    try {
      await replacement.peer.replay()
      await vi.waitFor(async () => expect(await replacement.appOutbox.list()).toEqual([]))
      expect(replacement.journal.slot()).toBeNull()
      expect(hub.published.filter((frame) => frame.logPosition != null)).toHaveLength(2)
      expect(replacement.mls.epoch()).toBe(2)
    } finally {
      await replacement.peer.dispose()
      await replacement.peer.drained()
    }
  })

  test('a reply timer firing after disposal invokes no host port', async () => {
    const hub = new FakeHub()
    const secret = new Uint8Array(32).fill(0x77)
    const member = makeMLSPeer(hub, 'bob', secret, {
      members: ['alice', 'bob'],
      recovery: { getDelayMs: () => 60000 },
    })
    await member.peer.replay()
    const callbacks: Array<() => void> = []
    const original = globalThis.setTimeout
    const timers = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        if (delay === 60000) callbacks.push(() => callback(...args))
        return original(callback, delay, ...args)
      })
    const sealGroupInfo = vi.spyOn(member.mls, 'sealGroupInfo')
    const sealLedger = vi.spyOn(member.mls, 'sealLedger')
    const isLedgerComplete = vi.spyOn(member.mls, 'isLedgerComplete')
    try {
      const sender = createMemoryGroupMLS({
        recoverySecret: secret,
        localDID: 'alice',
        members: ['alice', 'bob'],
      })
      for (const kind of [HANDSHAKE_KIND.recoveryRequest, HANDSHAKE_KIND.ledgerRequest]) {
        const id = crypto.randomUUID()
        const request = await sender.createRecoveryRequest(id)
        const payload =
          kind === HANDSHAKE_KIND.recoveryRequest
            ? encodeRecoveryRequest(id, request)
            : encodeLedgerRequest(id, request)
        await hub.publish({
          senderDID: 'alice',
          topicID: rendezvousTopic(secret),
          payload: encodeHandshakeFrame(kind, payload),
        })
      }
      await vi.waitFor(() => expect(callbacks).toHaveLength(2))
      await member.peer.dispose()
      await member.peer.drained()
      sealGroupInfo.mockClear()
      sealLedger.mockClear()
      isLedgerComplete.mockClear()
      for (const callback of callbacks) callback()
      await new Promise((resolve) => original(resolve, 0))
      expect(sealGroupInfo).not.toHaveBeenCalled()
      expect(sealLedger).not.toHaveBeenCalled()
      expect(isLedgerComplete).not.toHaveBeenCalled()
    } finally {
      timers.mockRestore()
      await member.peer.dispose()
    }
  })

  test('drains fire-and-forget recovery notices without changing the lane result', async () => {
    const pause = gate()
    let entered = false
    let notices = 0
    const crypto = createFakeCrypto({ epoch: 1, localDID: 'alice' })
    const mls = createMemoryGroupMLS({
      localDID: 'alice',
      onAdvance: (epoch) => crypto.setEpoch(epoch),
    })
    mls.prepareRecovery = async () => 'renewal-required'
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0x7a), {
      crypto,
      mls,
      onRecovery: async () => {
        notices++
        entered = true
        await pause.promise
        throw new Error('observer failure')
      },
    })
    expect(await member.peer.recover()).toEqual({ advanced: false, reenact: [] })
    expect(entered).toBe(true)
    await member.peer.dispose()
    const drain = await pausedDrain(member.peer)
    const before = notices
    pause.release()
    await drain.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(notices).toBe(before)
  })

  test('drainedBeforeDisposeRejects', async () => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(0x78))
    await expect(member.peer.drained()).rejects.toThrow('dispose')
    await expect(
      member.peer.commit(buildLedgerCommit(member, ['role:alice=member'])),
    ).resolves.toMatchObject({})
    expect(member.mls.epoch()).toBe(2)
    await member.peer.dispose()
    await member.peer.drained()
  })

  test('drain resolves after a rejected teardown without hiding the dispose rejection', async () => {
    const error = new Error('transport close failed')
    const fake = new FakeHub()
    const member = makeMLSPeer(
      {
        publish: (params) => fake.publish(params),
        subscribe: (did, topic, options) => fake.subscribe(did, topic, options),
        unsubscribe: (did, topic) => fake.unsubscribe(did, topic),
        fetchTopic: (params) => fake.fetchTopic(params),
        receive: (did) => {
          const inner = fake.receive(did)
          const iterator = inner[Symbol.asyncIterator]()
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => iterator.next(),
              return: () => {
                throw error
              },
            }),
          }
        },
      },
      'alice',
      new Uint8Array(32).fill(0x79),
    )
    await member.peer.replay()
    await expect(member.peer.dispose()).rejects.toBe(error)
    await expect(member.peer.drained()).resolves.toBeUndefined()
  })
})
