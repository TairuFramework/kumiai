import type { AuthenticatedRosterAbsence, GroupConditionEvent } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { absenceFreshness } from '../src/safety-conditions.js'

const absence: AuthenticatedRosterAbsence = {
  groupID: 'absence-freshness',
  requesterDID: 'did:key:requester',
  requestID: 'request',
  epoch: 12,
  captureHead: null,
  groupInfoAuthenticator: new Uint8Array([12]),
  confirmedTranscriptHash: 'offered-transcript',
  responderDID: 'did:key:responder',
  responderKeyHash: 'responder-key',
  lineage: [
    { epoch: 10, authHash: 'continuing-branch' },
    { epoch: 12, authHash: 'head' },
  ],
  evidence: new Uint8Array([1]),
}
const facts = [{ epoch: 10, authHash: 'own-branch', confirmedTranscriptHash: 'own-transcript' }]

describe('authenticated absence freshness', () => {
  test('fresh unequal roster absence surfaces evidence and keeps retries', () => {
    expect(absenceFreshness(absence, 20, facts)).toBe('fresh')
  })
  test('same lineage older roster cannot prove absence', () => {
    expect(
      absenceFreshness({ ...absence, lineage: [{ authHash: 'own-branch', epoch: 10 }] }, 20, facts),
    ).toBe('freshness')
  })
  test('equal epoch same lineage fails absence freshness', () => {
    expect(
      absenceFreshness(
        { ...absence, epoch: 10, confirmedTranscriptHash: 'own-transcript', lineage: facts },
        10,
        facts,
      ),
    ).toBe('freshness')
  })
  test('equal epoch different lineage surfaces absence', () => {
    expect(absenceFreshness(absence, 12, facts)).toBe('fresh')
  })
  test('transcript difference proves retained branch freshness', () => {
    expect(absenceFreshness({ ...absence, epoch: 10, lineage: facts }, 20, facts)).toBe('fresh')
  })
  test('newer same lineage absence passes freshness', () => {
    expect(absenceFreshness({ ...absence, lineage: facts }, 11, facts)).toBe('fresh')
  })
  test('missing comparison evidence grants nothing', () => {
    expect(absenceFreshness(absence, 11, [])).toBe('comparison-missing')
  })
  test('stale responder below requester join epoch cannot prove absence', () => {
    // Removal at 5, reinvite at 8, latest 12. The legitimate requested span starts at 5.
    const retained = [5, 6, 8, 12].map((epoch) => ({
      epoch,
      authHash: `own-${epoch}`,
      confirmedTranscriptHash: `transcript-${epoch}`,
    }))
    const reply = {
      ...absence,
      epoch: 6,
      confirmedTranscriptHash: 'transcript-6',
      lineage: retained.slice(0, 2),
    }
    expect(reply.lineage.map((frame) => frame.epoch)).toEqual([5, 6])
    expect(absenceFreshness(reply, 12, retained)).toBe('freshness')
  })
})

import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createNotMemberFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    describe(`diagnosis / ${mode} / ownership context ${context}`, () => {
      async function run(
        fn: (f: Awaited<ReturnType<typeof createNotMemberFixture>>) => Promise<void>,
      ) {
        const f = await createNotMemberFixture({
          mode,
          ownershipContext: context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        })
        try {
          await fn(f)
        } finally {
          await f.close()
        }
      }
      test('advanced losing device removed on continuing branch surfaces not-member', () =>
        run(async (f) => {
          const before = await f.local().device.groups.ports(f.key).control.load()
          const proof = await f.proof()
          const verified = await f
            .mls()
            .capturedRecovery?.checkRosterAbsence?.(
              proof.evidence,
              proof.requestID,
              proof.requestKey,
            )
          expect(verified).toMatchObject({
            epoch: 12,
            lineage: expect.arrayContaining([{ epoch: 10, authHash: expect.any(String) }]),
          })
          await f.diagnose(proof)
          expect(await f.local().safety().status(f.key)).toMatchObject({
            hold: null,
            condition: 'not-member',
            evidence: { epoch: 12, responderCount: 1 },
          })
          expect(await f.local().device.groups.ports(f.key).control.load()).toEqual(before)
        }))
      test('clearHold cannot erase retrying not member condition', () =>
        run(async (f) => {
          await f.diagnose(await f.proof())
          const before = await f.local().safety().status(f.key)
          const admission = f.mls().sendAdmission()
          await f.local().safety().clearHold(f.key)
          expect(await f.local().safety().status(f.key)).toEqual(before)
          expect(f.mls().sendAdmission()).toEqual(admission)
          await f.diagnose(await f.proof())
          expect(await f.local().safety().status(f.key)).toEqual(before)
        }))
      test('diagnostic absence alone never refuses admission', () =>
        run(async (f) => {
          const before = f.mls().sendAdmission()
          await f.diagnose(await f.proof())
          expect(f.mls().sendAdmission()).toEqual(before)
          expect((await f.local().registry.access(f.key.groupID)).admission()).toEqual(before)
        }))
      test('new absence evidence coalesces once', () =>
        run(async (f) => {
          await f.diagnose(await f.proof())
          const first = await f.local().safety().events(f.key)
          expect(
            first.filter((event): event is GroupConditionEvent => event.kind === 'not-member'),
          ).toHaveLength(1)
          const before = await f.local().safety().status(f.key)
          await f.diagnose(await f.proof())
          expect(await f.local().safety().events(f.key)).toEqual(first)
          expect(await f.local().safety().status(f.key)).toEqual(before)
          await f.restart()
          await f.diagnose(await f.proof())
          expect(await f.local().safety().events(f.key)).toEqual(first)
          expect(await f.local().safety().status(f.key)).toEqual(before)
        }))
      test('not member ack preserves evidence until successful recovery', () =>
        run(async (f) => {
          await f.diagnose(await f.proof())
          const before = await f.local().safety().status(f.key)
          for (const event of await f.local().safety().events(f.key))
            await f.local().safety().ackEvent(f.key, event.id)
          expect(await f.local().safety().status(f.key)).toEqual(before)
          await f.diagnose(await f.proof())
          expect(await f.local().safety().events(f.key)).toEqual([])
          await f.advance()
          expect(await f.local().safety().status(f.key)).toMatchObject({
            condition: null,
            evidence: null,
          })
        }))
      test('every successful installation clears not member', () =>
        run(async (f) => {
          await f.diagnose(await f.proof())
          await f.advance()
          expect(await f.local().safety().status(f.key)).toMatchObject({
            condition: null,
            evidence: null,
          })
          expect(
            (await f.local().safety().events(f.key)).some((event) => event.kind === 'not-member'),
          ).toBe(true)
        }))
      test('rollback or pending proof keeps the condition', () =>
        run(async (f) => {
          await f.diagnose(await f.proof())
          const before = await f.local().safety().status(f.key)
          f.local().armNextWorkFault('before-commit')
          await expect(f.advance()).rejects.toThrow()
          expect(await f.local().safety().status(f.key)).toEqual(before)
        }))
      test('late condition proof cannot affect replacement incarnation', () =>
        run(async (f) => {
          const proof = await f.proof()
          f.stop()
          await f.diagnose(proof)
          expect(await f.local().safety().status(f.key)).toMatchObject({
            condition: null,
            evidence: null,
          })
        }))
      test('callers cannot manufacture condition authority', () =>
        run(async (f) => {
          const service = f.service()
          await expect(
            service.updateRecords({
              put: [
                {
                  kind: 'condition',
                  id: 'forged',
                  key: f.key,
                  active: true,
                  sealedProof: null,
                  event: {
                    ...f.key,
                    id: 'forged',
                    kind: 'not-member',
                    detectedAt: Date.now(),
                    evidence: null,
                  },
                },
              ],
            }),
          ).rejects.toThrow('authority')
          const groups = f.local().device.groups
          await expect(
            groups.transition(
              {
                groupID: f.key.groupID,
                mutationID: crypto.randomUUID(),
                expected: await groups.load(f.key.groupID),
              },
              async (stores) => {
                await stores.checkpoints.put({
                  kind: 'condition',
                  id: 'forged-directly',
                  key: f.key,
                  active: true,
                  sealedProof: null,
                  event: {
                    ...f.key,
                    id: 'forged-directly',
                    kind: 'not-member',
                    detectedAt: Date.now(),
                    evidence: null,
                  },
                })
              },
            ),
          ).rejects.toThrow('authority')
          expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
        }))
    })
  }
}

test('stale responder below requester join epoch cannot prove absence with a valid signed span', async () => {
  const { createCapturedFormerMember } = await import('./fixtures/captured-recovery.js')
  const { createRegistryFixture } = await import('./fixtures/registry.js')
  const { createRegistryGroupMLS } = await import('../src/registry-group-mls.js')
  const { createLedgerEntrySlot } = await import('../src/mls.js')
  const { createCheckpointService } = await import('../src/checkpoint.js')
  const { createNotMemberHandler, retainedComparisonFacts } = await import(
    '../src/safety-conditions.js'
  )
  const { recoveryTrustFor } = await import('../src/registry/trust.js')
  const {
    commitKeyRotation,
    restoreGroup,
    decodeClientState,
    encodeClientState,
    proposeSelfRemoval,
    commitSelfRemovals,
    createKeyPackageBundle,
    createInvite,
    commitInvite,
    processWelcome,
    parseMLSCredentialIdentity,
  } = await import('@kumiai/mls')
  const base = await createCapturedFormerMember(true)
  const local = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: base.requester.handle.groupID,
    identity: base.requester.identity,
  })
  const remote = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID: base.requester.handle.groupID,
    identity: base.responder.identity,
  })
  try {
    const clone = async (handle: typeof base.requester.handle, fixture: typeof local) => {
      const state = decodeClientState(encodeClientState(handle.state))
      if (state === undefined) throw new Error('Missing state')
      return restoreGroup({
        state,
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: fixture.environment.options,
      })
    }
    let own = await clone(base.requester.handle, local)
    let continuing = await clone(base.earlierGroup, remote)
    while (Number(continuing.epoch) < 4) {
      const rotation = await commitKeyRotation(continuing)
      continuing = rotation.newGroup
      await own.processMessage(rotation.commitMessage)
    }
    const sourceKey = await local.registry.seed(own, {
      packageUse: { sourceID: 'stale', ref: 'first-join', kind: 'ordinary' },
    })
    const remoteKey = await remote.registry.seed(await clone(continuing, remote), {
      packageUse: { sourceID: 'stale', ref: 'responder', kind: 'ordinary' },
    })
    async function install(fixture: typeof local, key: typeof sourceKey, handle: typeof own) {
      const previous = await fixture.device.groups.loadState(key)
      if (previous === null || previous.deleted) throw new Error('Missing installed state')
      await fixture.installRows({
        key,
        state: {
          ...previous,
          version: previous.version + 1,
          state: encodeClientState(handle.state),
          credential: handle.credential,
          ledger: handle.ledgerTokens,
          epoch: Number(handle.epoch),
          epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
        },
        trust: recoveryTrustFor(handle, key, await fixture.device.groups.loadTrust(key.groupID)),
      })
    }
    const removal = await proposeSelfRemoval(await clone(own, local))
    await continuing.processMessage(removal.frame)
    const removed = await commitSelfRemovals(continuing)
    if (removed === null) throw new Error('Missing removal at 5')
    continuing = removed.newGroup
    expect(Number(continuing.epoch)).toBe(5)
    await install(remote, remoteKey, continuing)
    continuing = (await commitKeyRotation(continuing)).newGroup
    await install(remote, remoteKey, continuing)
    expect(Number(continuing.epoch)).toBe(6)
    continuing = (await commitKeyRotation(continuing)).newGroup
    const ownLeaf = own.state.ratchetTree[own.state.privatePath.leafIndex * 2]
    if (ownLeaf?.nodeType !== 1 || !('identity' in ownLeaf.leaf.credential))
      throw new Error('Missing requester controller')
    const controller = parseMLSCredentialIdentity(ownLeaf.leaf.credential.identity).controller
    const bundle = await createKeyPackageBundle(base.requester.identity, { controller })
    const { invite } = await createInvite({
      group: continuing,
      identity: base.responder.identity,
      recipientDID: base.requester.identity.id,
    })
    const added = await commitInvite(continuing, bundle.publicPackage, invite)
    own = (
      await processWelcome({
        identity: base.requester.identity,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        options: local.environment.options,
      })
    ).group
    expect(Number(own.epoch)).toBe(8)
    const key = await local.registry.seed(own, {
      replace: true,
      packageUse: { sourceID: 'stale', ref: 'reinvite-at-eight', kind: 'ordinary' },
    })
    while (Number(own.epoch) < 12) {
      own = (await commitKeyRotation(own)).newGroup
      await install(local, key, own)
    }
    const target = { targetID: 'stale-responder', topicID: 'stale-commits' }
    const requester = await createRegistryGroupMLS({
      registry: local.registry,
      key,
      identity: local.identity,
      entrySlot: createLedgerEntrySlot(),
      recovery: local.environment,
      target,
    })
    const responder = await createRegistryGroupMLS({
      registry: remote.registry,
      key: remoteKey,
      identity: remote.identity,
      entrySlot: createLedgerEntrySlot(),
      recovery: remote.environment,
      target,
    })
    const remoteService = createCheckpointService({
      registry: remote.registry,
      key: remoteKey,
      identity: remote.identity,
    })
    for (const row of await remoteService.readRecords())
      if (row.kind === 'fact') await remoteService.signInstalled(row.id)
    const requestID = crypto.randomUUID()
    const held = await requester.createRecoveryRequest(requestID, undefined, 4)
    const evidence = await responder.capturedRecovery?.sealRosterAbsence?.(held.request, null)
    if (evidence == null) throw new Error('Missing legitimate span through 6')
    const verified = await requester.capturedRecovery?.checkRosterAbsence?.(
      evidence,
      requestID,
      held.requestKey,
    )
    expect(verified).toMatchObject({
      epoch: 6,
      lineage: [{ epoch: 4 }, { epoch: 5 }, { epoch: 6 }],
    })
    if (verified == null) throw new Error('Framing or span verification rejected the witness')
    const service = createCheckpointService({
      registry: local.registry,
      key,
      identity: local.identity,
    })
    expect(
      absenceFreshness(verified, 12, retainedComparisonFacts(await service.readRecords(), key)),
    ).toBe('freshness')
    await createNotMemberHandler({
      registry: local.registry,
      key,
      recovery: local.environment,
      current: () => true,
    })({ evidence, requestID, requestKey: held.requestKey })
    expect(await local.safety().status(key)).toMatchObject({ condition: null, evidence: null })
  } finally {
    await local.close()
    await remote.close()
  }
})

test('absence event counts distinct responder DIDs', async () => {
  const f = await createNotMemberFixture({ additionalResponder: true, sameDIDResponder: true })
  try {
    await f.diagnose(await f.proof())
    const first = await f.local().safety().status(f.key)
    expect(first.evidence).toMatchObject({ responderDIDs: [f.responderDID], responderCount: 1 })
    const rotated = await f.secondProof(0)
    expect(rotated.responderDID).toBe(f.responderDID)
    await f.diagnose(rotated)
    const sameDID = await f.local().safety().status(f.key)
    expect(sameDID.evidence?.responderKeyHash).not.toBe(first.evidence?.responderKeyHash)
    expect(sameDID.evidence).toMatchObject({ responderDIDs: [f.responderDID], responderCount: 1 })
    const second = await f.secondProof()
    expect(second.responderDID).not.toBe(f.responderDID)
    await f.diagnose(second)
    expect(await f.local().safety().status(f.key)).toMatchObject({
      evidence: { responderDIDs: [f.responderDID, second.responderDID].sort(), responderCount: 2 },
    })
    expect(
      (await f.local().safety().events(f.key)).filter(
        (event): event is GroupConditionEvent => event.kind === 'not-member',
      ),
    ).toHaveLength(1)
    await f.restart()
    const observedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt + 30001)
    try {
      const events = (await f.local().safety().events(f.key)).filter(
        (event): event is GroupConditionEvent => event.kind === 'not-member',
      )
      expect(events).toHaveLength(2)
      expect(events[1]?.evidence).toMatchObject({
        responderDIDs: [f.responderDID, second.responderDID].sort(),
        responderCount: 2,
      })
      expect(await f.local().safety().status(f.key)).toMatchObject({
        evidence: { responderCount: 2 },
      })
    } finally {
      clock.mockRestore()
    }
  } finally {
    await f.close()
  }
})

test('ordinary event writes cannot manufacture diagnostic evidence', async () => {
  const f = await createNotMemberFixture()
  try {
    await f.local().installRows({
      key: f.key,
      events: [
        {
          ...f.key,
          id: 'invented-absence',
          kind: 'not-member',
          detectedAt: Date.now(),
          evidence: {
            responderKeyHash: 'invented',
            epoch: 999,
            authHash: 'invented',
            observedAt: Date.now(),
            responderDIDs: ['invented'],
            responderCount: 1,
          },
        },
      ],
    })
    expect(await f.local().safety().events(f.key)).toEqual([])
    expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
  } finally {
    await f.close()
  }
})

test('condition evidence follows checkpoint retention bounds', async () => {
  const f = await createNotMemberFixture()
  try {
    await f.diagnose(await f.proof())
    await f.advance()
    expect(
      (await f.local().safety().events(f.key)).some((event) => event.kind === 'not-member'),
    ).toBe(true)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 604800001)
    try {
      await f.local().installRows({ key: f.key, control: {} })
      expect((await f.service().readRecords()).filter((row) => row.kind === 'condition')).toEqual(
        [],
      )
      expect(await f.local().safety().events(f.key)).toEqual([])
    } finally {
      clock.mockRestore()
    }
  } finally {
    await f.close()
  }
})

test('late condition proof cannot affect a replacement incarnation', async () => {
  const f = await createNotMemberFixture()
  try {
    const proof = await f.proof()
    const recovery = await f.confirmedRecovery()
    if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
      throw new Error('Missing confirmed switch')
    const destination = await f.local().registry.switchIncarnation(recovery.candidate, {
      source: recovery.source,
      rejoinID: recovery.record.id,
      proof: recovery.proof,
      write: {
        mutationID: recovery.record.switchMutationID,
        source: { rejoinID: recovery.record.id },
        destination: {
          control: {
            cursor: { position: recovery.proof.position, epoch: Number(recovery.candidate.epoch) },
          },
        },
      },
    })
    expect(destination.incarnation).toBe(2)
    await f.diagnose(proof)
    expect(await f.local().safety().status(destination)).toMatchObject({
      condition: null,
      evidence: null,
    })
    expect((await f.service().readRecords()).filter((row) => row.kind === 'condition')).toEqual([])
  } finally {
    await f.close()
  }
})

test('former requester receives roster but never seen requester stays pending', async () => {
  const f = await createNotMemberFixture()
  try {
    const { randomIdentity } = await import('@kokuin/token')
    const { createGroup, createRecoveryRequest } = await import('@kumiai/mls')
    const known = await f.proof()
    expect(
      await f
        .mls()
        .capturedRecovery?.checkRosterAbsence?.(known.evidence, known.requestID, known.requestKey),
    ).toMatchObject({ epoch: 12 })
    const stranger = randomIdentity()
    const group = (await createGroup(stranger, f.key.groupID)).group
    const requestID = crypto.randomUUID()
    const unknown = await createRecoveryRequest({
      group,
      identity: stranger,
      requestID,
      comparisonEpoch: 10,
    })
    expect(
      await f.remoteMLS.capturedRecovery?.sealRosterAbsence?.(
        new TextEncoder().encode(unknown.request),
        null,
      ),
    ).toBeNull()
    expect(await f.local().safety().status(f.key)).toMatchObject({ condition: null })
  } finally {
    await f.close()
  }
})

test.each(['seed', 'own-commit', 'confirmed-recovery'] as const)(
  'every successful installation clears not member: %s',
  async (installation) => {
    const f = await createNotMemberFixture()
    try {
      await f.diagnose(await f.proof())
      let destination = f.key
      if (installation === 'confirmed-recovery') {
        const recovery = await f.confirmedRecovery()
        if (!('format' in recovery.record) || recovery.record.switchMutationID === null)
          throw new Error('Missing confirmed recovery')
        destination = await f.local().registry.switchIncarnation(recovery.candidate, {
          source: recovery.source,
          rejoinID: recovery.record.id,
          proof: recovery.proof,
          write: {
            mutationID: recovery.record.switchMutationID,
            source: { rejoinID: recovery.record.id },
            destination: {
              control: {
                cursor: {
                  position: recovery.proof.position,
                  epoch: Number(recovery.candidate.epoch),
                },
              },
            },
          },
        })
      } else {
        const access = await f.local().registry.access(f.key.groupID)
        if (installation === 'own-commit') {
          await access.mutate(async (handle, persist) => {
            await persist(await f.local().advance(handle))
          })
        } else {
          const next = await access.read((handle) => f.local().advance(handle))
          destination = await f.local().registry.seed(next, {
            replace: true,
            packageUse: {
              sourceID: 'successful-installation',
              ref: 'fresh-welcome',
              kind: 'ordinary',
            },
          })
        }
      }
      expect(await f.local().safety().status(f.key)).toMatchObject({
        condition: null,
        evidence: null,
      })
      expect(await f.local().safety().status(destination)).toMatchObject({
        condition: null,
        evidence: null,
      })
      expect(
        (await f.local().safety().events(f.key)).some((event) => event.kind === 'not-member'),
      ).toBe(true)
    } finally {
      await f.close()
    }
  },
)

test('pending installation proof never clears the condition', async () => {
  const f = await createNotMemberFixture()
  try {
    await f.diagnose(await f.proof())
    const before = await f.local().safety().status(f.key)
    const fault = f.local().armNextWorkFault('pending')
    const attempt = f.advance()
    void attempt.catch(() => {})
    await fault.rejected
    let readCompleted = false
    const reading = f
      .local()
      .safety()
      .status(f.key)
      .then((value) => {
        readCompleted = true
        return value
      })
    await Promise.resolve()
    expect(readCompleted).toBe(false)
    await fault.finish('rollback')
    await expect(attempt).rejects.toThrow()
    expect(await reading).toEqual(before)
  } finally {
    await f.close()
  }
})

test('coordinator re-verifies sealed absence rather than accepting a diagnosis object', async () => {
  const f = await createNotMemberFixture()
  try {
    const proof = await f.proof()
    proof.evidence[0] = (proof.evidence[0] ?? 0) ^ 255
    await f.diagnose(proof)
    expect(await f.local().safety().status(f.key)).toMatchObject({
      condition: null,
      evidence: null,
    })
    expect(await f.local().safety().events(f.key)).toEqual([])
  } finally {
    await f.close()
  }
})
