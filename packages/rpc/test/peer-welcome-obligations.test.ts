import { describe, expect, test, vi } from 'vitest'

import type { WelcomeObligation } from '../src/control/types.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildInviteCommit, makeMLSPeer } from './fixtures/peer.js'

const secret = new Uint8Array(32).fill(0x48)
const obligation: WelcomeObligation = {
  opID: crypto.randomUUID(),
  welcome: new Uint8Array([1, 2, 3]),
  recipients: ['bob'],
  committed: true,
}

describe('durable Welcome obligations', () => {
  test('delivers the committed artifact and deletes only after transport acceptance', async () => {
    const hub = new FakeHub()
    const seen: Array<WelcomeObligation> = []
    const member = makeMLSPeer(hub, 'alice', secret, {
      deliverWelcome: async (row) => {
        expect(member.mls.epoch()).toBe(2)
        expect((await member.control.load()).operations).toEqual([])
        expect((await member.control.load()).applied[0]?.opID).toBe(row.opID)
        expect(row.committed).toBe(true)
        expect((await member.control.load()).welcomes).toEqual([row])
        seen.push(structuredClone(row))
      },
    })
    try {
      const request = buildInviteCommit(member, 'bob', {
        transform: (built) => ({
          ...built,
          welcome: { bytes: obligation.welcome, recipients: ['bob'] },
        }),
      })
      await member.peer.commit(request)
      expect(seen).toEqual([{ ...obligation, opID: request.id }])
      expect((await member.control.load()).welcomes).toEqual([])
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  })

  test('a crash after acceptance leaves an obligation delivered on restart', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    await member.peer.resync()
    const stopAtAcceptance = () => {
      member.database.seam('after-apply', async () => {
        if ((await member.control.load()).operations[0]?.stage === 'accepted')
          void member.peer.dispose()
        else stopAtAcceptance()
      })
    }
    stopAtAcceptance()
    const request = buildInviteCommit(member, 'bob')
    await member.peer.enqueue(request)
    await expect.poll(async () => (await member.control.load()).welcomes.length).toBe(1)
    await member.peer.dispose()
    await member.peer.drained()
    expect(member.welcomes).toEqual([])
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    try {
      await restarted.peer.resync()
      expect(restarted.welcomes).toEqual([request.id])
      expect((await restarted.control.load()).welcomes).toEqual([])
    } finally {
      await restarted.peer.dispose()
      await restarted.peer.drained()
    }
  })

  test('transport acceptance before deletion is delivered again after restart', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret, {
      deliverWelcome: async (row) => {
        member.welcomes.push(row.opID)
        void member.peer.dispose()
      },
    })
    await member.peer.resync()
    const request = buildInviteCommit(member, 'bob')
    await member.peer.enqueue(request)
    await expect.poll(() => member.welcomes).toEqual([request.id])
    await member.peer.dispose()
    await member.peer.drained()
    expect((await member.control.load()).welcomes).toHaveLength(1)
    const restarted = makeMLSPeer(hub, 'alice', secret, { restartOf: member })
    try {
      await restarted.peer.resync()
      expect(restarted.welcomes).toEqual([request.id, request.id])
      expect((await restarted.control.load()).welcomes).toEqual([])
    } finally {
      await restarted.peer.dispose()
      await restarted.peer.drained()
    }
  })

  test('startup delivers obligations even without an operation or a working adoption', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    await member.peer.resync()
    await member.control.apply({ putWelcomes: [obligation] }, crypto.randomUUID())
    await member.peer.dispose()
    await member.peer.drained()
    const restarted = makeMLSPeer(hub, 'alice', secret, {
      restartOf: member,
      adopt: async () => {
        throw new Error('adoption unavailable')
      },
    })
    try {
      await restarted.peer.resync()
      expect(restarted.welcomes).toEqual([obligation.opID])
      expect((await restarted.control.load()).welcomes).toEqual([])
    } finally {
      await restarted.peer.dispose()
      await restarted.peer.drained()
    }
  })

  test('delivery failure retains the obligation and retries without another operation', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    await member.peer.resync()
    await member.control.apply({ putWelcomes: [obligation] }, crypto.randomUUID())
    await member.peer.dispose()
    await member.peer.drained()
    let attempts = 0
    const restarted = makeMLSPeer(hub, 'alice', secret, {
      restartOf: member,
      deliverWelcome: async (row) => {
        attempts++
        if (attempts === 1) throw new Error('transport unavailable')
        restarted.welcomes.push(row.opID)
      },
    })
    try {
      await restarted.peer.resync()
      expect((await restarted.control.load()).welcomes).toEqual([obligation])
      await vi.waitFor(async () => expect((await restarted.control.load()).welcomes).toEqual([]), {
        timeout: 3000,
      })
      expect(restarted.welcomes).toEqual([obligation.opID])
    } finally {
      await restarted.peer.dispose()
      await restarted.peer.drained()
    }
  })

  test('ambiguous committed deletion is read back without redelivery', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret, {
      deliverWelcome: async (row) => {
        member.welcomes.push(row.opID)
        member.database.commitThenRejectNext('apply')
      },
    })
    try {
      await member.peer.commit(buildInviteCommit(member, 'bob'))
      expect(member.welcomes).toHaveLength(1)
      expect((await member.control.load()).welcomes).toEqual([])
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  })

  test('an unavailable recipient does not block later obligations or their deletion', async () => {
    const hub = new FakeHub()
    const member = makeMLSPeer(hub, 'alice', secret)
    await member.peer.resync()
    const later = { ...obligation, opID: crypto.randomUUID(), recipients: ['carol'] }
    await member.control.apply({ putWelcomes: [obligation, later] }, crypto.randomUUID())
    await member.peer.dispose()
    await member.peer.drained()
    let unavailable = true
    const attempts: Array<string> = []
    const restarted = makeMLSPeer(hub, 'alice', secret, {
      restartOf: member,
      deliverWelcome: async (row) => {
        attempts.push(row.opID)
        if (row.opID === obligation.opID && unavailable) throw new Error('transport unavailable')
        restarted.welcomes.push(row.opID)
      },
    })
    try {
      await restarted.peer.resync()
      expect(restarted.welcomes).toEqual([later.opID])
      expect((await restarted.control.load()).welcomes).toEqual([obligation])
      expect(attempts).toEqual([obligation.opID, later.opID])
      unavailable = false
      await vi.waitFor(async () => expect((await restarted.control.load()).welcomes).toEqual([]), {
        timeout: 3000,
      })
      expect(restarted.welcomes).toEqual([later.opID, obligation.opID])
      expect(attempts).toEqual([obligation.opID, later.opID, obligation.opID])
    } finally {
      await restarted.peer.dispose()
      await restarted.peer.drained()
    }
  })
})
