import { decodeClientState, encodeClientState } from '@kumiai/mls'
import {
  createControlAdoptionPort,
  createControlValidationPort,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import {
  asLogPosition,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type Operation,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { controlAdoptionFixture } from '../../../packages/mls-rpc/test/fixtures/control-adoption.js'
import { createMemoryHostDatabase } from './host-db.js'

test.each(['hold', 'coverage', 'group-key', 'incarnation'] as const)(
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
    const access = simpleHandleAccess({
      key,
      handle: () => current,
      adopt: (next) => {
        current = next
      },
      stateVersion: () => db.loadVersion(key.groupID),
      persist: async (next, write) => {
        let persistedWrite = write
        if (changed === 'hold' || changed === 'coverage') {
          await control.apply(
            changed === 'hold'
              ? { controlHold: { reason: 'unsupported-version', position: f.proof.position } }
              : {
                  commitOnce: { ...f.slot, skipped: true },
                  cursor: { position: asLogPosition('000000'), epoch: f.slot.epoch },
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
    expect(
      await port.adopt(f.slot.journal, { ...source, occurrence: { ...f.proof, source } }, f.write),
    ).toBe('moved')
    expect(current.epoch).toBe(epochBefore)
    const saved = decodeClientState((await db.loadState(key.groupID)) ?? new Uint8Array())
    expect(saved?.groupContext.epoch).toBe(epochBefore)
    expect((await control.load()).applied).toEqual([])
  },
)

test.each(['framing poison', 'transient candidate storage failure'] as const)(
  '%s permits later saved adoption without a safety hold',
  async (failure) => {
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
    await db.seed(key.groupID, encodeClientState(current.state))
    const intent: Operation = {
      id: f.slot.opID,
      kind: f.slot.kind,
      revokes: f.slot.revokes,
      enqueuedAt: f.slot.enqueuedAt,
      deadline: f.slot.deadline,
      seq: 1,
      stage: 'intent',
      body: new Uint8Array(),
    }
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(f.rotation.commitMessage, new Uint8Array()),
    )
    const slot = {
      ...f.slot,
      payload,
      payloadDigest: toB64U(sha256(payload)),
      digest: digestAppliedCommit(f.rotation.commitMessage),
    }
    await control.apply({ putOperations: [{ ...intent, stage: 'intent' }] }, 'intent')
    const access = simpleHandleAccess({
      key,
      handle: () => current,
      adopt: (next) => {
        current = next
      },
      stateVersion: () => db.loadVersion(key.groupID),
      persist: (next, write) => db.saveState(key.groupID, encodeClientState(next.state), write),
    })
    const source = await access.readControl(async (scope) => scope.source)
    expect(
      await db.saveBuilt(key.groupID, key, { ...intent, stage: 'intent' }, slot, source, 'built'),
    ).toBe('saved')
    await control.apply(
      {
        putOutcomes: [{ id: 'owed', opID: null, at: 1, kind: 'unknown' }],
        putWelcomes: [
          { opID: 'owed-invite', welcome: new Uint8Array([7]), recipients: ['invitee'] },
        ],
      },
      'owed',
    )
    const before = await control.load()
    const position = asLogPosition('000002')
    const fault = new Error('candidate storage offline')
    const restoreCandidate = vi.fn(f.restoreCandidate)
    if (failure === 'transient candidate storage failure')
      restoreCandidate.mockRejectedValueOnce(fault)
    const validationPort = createControlValidationPort({
      identity: f.member.identity,
      options: {},
      restoreCandidate,
    })
    const validate = async () => {
      const validation = await validationPort.restoreValidation(slot)
      if (validation === null) throw new Error('Missing saved validation')
      return validation.validateFrame({ position, payload, senderDID: f.member.identity.id }, slot)
    }
    if (failure === 'transient candidate storage failure') {
      await expect(validate()).rejects.toBe(fault)
      expect(await control.load()).toEqual(before)
      expect(current).toBe(f.member.handle)
    }
    const validation = await validationPort.restoreValidation(slot)
    if (validation === null) throw new Error('Missing saved validation')
    expect(
      await validation.validateFrame(
        { position: asLogPosition('000001'), payload: new Uint8Array(), senderDID: 'relay' },
        slot,
      ),
    ).toMatchObject({ kind: 'invalid' })
    await control.apply(
      {
        commitOnce: { ...slot, skipped: true },
        cursor: { position: asLogPosition('000001'), epoch: slot.epoch },
      },
      'skip-poison',
    )
    expect(await validate()).toMatchObject({ kind: 'valid', own: true })
    const occurrence = {
      source,
      position,
      payloadDigest: slot.payloadDigest,
      coverage: 'incomplete' as const,
    }
    const diagnosed = await control.load()
    expect(diagnosed.forkHalt).toBeNull()
    expect(diagnosed.recoveryUnavailable).toBeNull()
    expect(diagnosed.controlHold).toBeNull()
    expect(diagnosed.commitOnce).toEqual({ ...before.commitOnce, skipped: true })
    const port = createControlAdoptionPort({
      access,
      control,
      restoreCandidate: f.restoreCandidate,
    })
    expect(
      await port.adopt(
        slot.journal,
        { ...source, occurrence },
        {
          ...f.write,
          anchorLanded: slot.digest,
          changes: {
            ...f.write.changes,
            putOutcomes: [{ id: 'installed-fact', opID: slot.opID, at: 100, kind: 'unknown' }],
            putApplied: [
              {
                epoch: slot.epoch,
                digest: slot.digest,
                payloadDigest: slot.payloadDigest,
                sequenceID: position,
                opID: slot.opID,
                removed: false,
              },
            ],
            cursor: { position, epoch: slot.epoch + 1 },
          },
        },
      ),
    ).toBe('installed')
    await expect
      .poll(async () => (await control.load()).cursor, { timeout: 1000 })
      .toEqual({
        position,
        epoch: slot.epoch + 1,
      })
    const after = await control.load()
    expect(current.epoch).toBe(BigInt(slot.epoch + 1))
    expect(after.cursor).toEqual({ position, epoch: slot.epoch + 1 })
    expect(after.applied).toEqual([
      expect.objectContaining({ sequenceID: position, digest: slot.digest }),
    ])
    expect(after.welcomes).toEqual(before.welcomes)
    expect(after.outcomes).toEqual(
      expect.arrayContaining([
        ...before.outcomes,
        { id: 'installed-fact', opID: slot.opID, at: 100, kind: 'unknown' },
      ]),
    )
    expect(after.forkHalt).toBeNull()
    expect(after.recoveryUnavailable).toBeNull()
    expect(after.controlHold).toBeNull()
  },
)
