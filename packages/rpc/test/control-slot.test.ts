import { expect, test } from 'vitest'

import { closeControlBuild } from '../src/control/slot.js'
import { asLogPosition } from '../src/cursor.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { buildInviteCommit, makeMLSPeer, seedBuiltOperation } from './fixtures/peer.js'

test.todo(
  'acknowledging a provisional ID after own installation preserves the fresh final outcome (R3: reporting identities and acknowledgement races)',
)
test.todo(
  'fork halt evidence survives restart and returned byte mutation (R3: lifecycle persistence of safety fields)',
)
test.todo(
  'ambiguous own installation obeys an aborted signal without another installation (R3: retry completion and cancellation)',
)
test.todo(
  'a stale installation under a safety hold changes no final outcome (R3: lifecycle replay admission)',
)

test.each(['landed', 'lost', 'unknown'] as const)(
  'closure %s preserves independent obligations and replaces provisional reports',
  async (kind) => {
    const member = makeMLSPeer(new FakeHub(), 'alice', new Uint8Array(32).fill(67))
    try {
      await member.peer.replay()
      const saved = await seedBuiltOperation(member, buildInviteCommit(member, 'guest'))
      const provisional = { id: 'provisional', opID: saved.id, kind: 'unknown' as const, at: 1 }
      const obligation = {
        opID: 'prior-invite',
        welcome: new Uint8Array([7]),
        recipients: ['prior-guest'],
        committed: true as const,
      }
      await member.control.apply({ putOutcomes: [provisional], putWelcomes: [obligation] }, 'owed')
      const snapshot = await member.control.load()
      const changes = closeControlBuild(
        snapshot,
        kind === 'landed' ? { kind, position: asLogPosition('000002') } : { kind },
        2,
        'final',
      )
      expect(changes.commitOnce).toBeNull()
      expect(changes.deleteOutcomes).toEqual(['provisional'])
      expect(changes.putOutcomes).toMatchObject([{ id: 'final', opID: saved.id, at: 2, kind }])
      expect(changes.deleteWelcomes).toBeUndefined()
      expect(changes.putWelcomes).toEqual(
        kind === 'landed'
          ? [
              {
                opID: saved.id,
                welcome: saved.slot.welcome?.bytes,
                recipients: saved.slot.welcome?.recipients,
                committed: true,
              },
            ]
          : undefined,
      )
      expect((await member.control.load()).welcomes).toEqual([obligation])
    } finally {
      await member.peer.dispose()
      await member.peer.drained()
    }
  },
)
