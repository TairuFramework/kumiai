import { decodeClientState, encodeClientState } from '@kumiai/mls'
import { createControlAdoptionPort, simpleHandleAccess } from '@kumiai/mls-rpc'
import { asLogPosition, type Operation } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { controlAdoptionFixture } from '../../../packages/mls-rpc/test/fixtures/control-adoption.js'
import { createMemoryHostDatabase } from './host-db.js'

test.each(['hold', 'acceptance', 'group-key', 'incarnation'] as const)(
  'the simple host refuses a %s changed in the persist callback after preparation',
  async (changed) => {
    const f = await controlAdoptionFixture()
    const key = f.proof.source.key
    const db = createMemoryHostDatabase({
      readIdentity: (bytes, identityKey) => {
        const state = decodeClientState(bytes)
        return state === undefined
          ? null
          : {
              ...identityKey,
              epoch: Number(state.groupContext.epoch),
              authenticator: state.keySchedule.epochAuthenticator,
            }
      },
    })
    const control = db.control(key.groupID, key)
    let current = f.member.handle
    const epochBefore = current.epoch
    await db.seed(key.groupID, encodeClientState(current.state))
    const intent: Operation & { stage: 'intent' } = {
      ...f.store.snapshot().control.operations[0],
      id: 'rotation',
      kind: 'rotation',
      revokes: false,
      body: new Uint8Array(),
      seq: 1,
      enqueuedAt: 0,
      deadline: 30_000,
      stage: 'intent',
    }
    await control.apply({ putOperations: [intent] }, 'intent')
    const source = {
      key,
      identity: {
        ...key,
        epoch: Number(current.epoch),
        authenticator: current.state.keySchedule.epochAuthenticator,
      },
      stateVersion: await db.loadVersion(key.groupID),
    }
    expect(await db.saveBuilt(key.groupID, key, intent, f.slot, source, 'built')).toBe('saved')
    await control.apply({ commitOnceAcceptance: f.proof }, 'accepted')
    const access = simpleHandleAccess({
      key,
      handle: () => current,
      adopt: (next) => {
        current = next
      },
      stateVersion: () => db.loadVersion(key.groupID),
      persist: async (next, write) => {
        let persistedWrite = write
        if (changed === 'hold' || changed === 'acceptance') {
          await control.apply(
            changed === 'hold'
              ? { controlHold: { reason: 'unsupported-version', position: f.proof.position } }
              : {
                  commitOnceAcceptance: { ...f.proof, position: asLogPosition('other-occurrence') },
                },
            'race',
          )
        } else {
          if (write?.expected?.identity == null) throw new Error('Missing adoption expectation')
          const expectedKey =
            changed === 'group-key'
              ? { ...key, groupID: 'other-group' }
              : { ...key, incarnation: key.incarnation + 1 }
          persistedWrite = {
            ...write,
            expected: {
              ...write.expected,
              key: expectedKey,
              identity: { ...write.expected.identity, ...expectedKey },
            },
          }
        }
        const before = await db.snapshot(key.groupID)
        try {
          await db.saveState(key.groupID, encodeClientState(next.state), persistedWrite)
        } finally {
          expect(await db.snapshot(key.groupID)).toEqual(before)
        }
      },
    })
    const port = createControlAdoptionPort({
      access,
      control,
      restoreCandidate: f.restoreCandidate,
    })
    expect(await port.adopt(f.slot.journal, { ...source, acceptance: f.proof }, f.write)).toBe(
      'moved',
    )
    expect(current.epoch).toBe(epochBefore)
    const saved = decodeClientState((await db.loadState(key.groupID)) ?? new Uint8Array())
    expect(saved?.groupContext.epoch).toBe(epochBefore)
    expect((await control.load()).applied).toEqual([])
  },
)
