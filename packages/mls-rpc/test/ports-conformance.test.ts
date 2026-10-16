import {
  confirmationTag,
  decodeClientState,
  decodeEpochCheckpoint,
  encodeClientState,
  restoreGroup,
} from '@kumiai/mls'
import {
  type AuthenticatedRosterAbsence,
  type CapturedRecoveryPort,
  type GroupCrypto,
  type GroupMLS,
  isAppFrameStorageError,
  type LogPosition,
  type PendingAppFrame,
} from '@kumiai/rpc'
import {
  type ConformanceAuthenticatedRosterAbsence,
  type ConformanceCapturedRecoveryPort,
  type ConformanceCryptoMember,
  type ConformanceGroupMLS,
  type ConformanceMLSMember,
  testForkRecoveryConformance,
  testGroupCryptoConformance,
  testGroupMLSConformance,
  testPendingGroupCryptoConformance,
} from '@kumiai/rpc-conformance'
import { nodeTypes } from 'ts-mls'
import { expect, test } from 'vitest'

import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import {
  createCapturedRealRecovery,
  createForkRecoveryRealFixture,
} from './fixtures/captured-recovery.js'
import {
  buildRealCommit,
  buildRealExternalCommit,
  buildRealRotation,
  buildRealUnavailableCommit,
  createRealBoundRecovery,
  createRealGroup,
  persistedTestAccess,
  sealRealRecoveryVerdict,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

/**
 * The port contracts, against real MLS. The identical suites run in `@kumiai/rpc` over the test
 * doubles, and running the two against one contract is the whole point: a clause only one side
 * can pass is a divergence, and every divergence found this way had already cost something.
 */

// The suite's port shapes are structural — it cannot import `@kumiai/rpc` without putting a cycle
// in the package graph — so this is what keeps them honest: the REAL port types must be assignable
// to them, checked by the compiler rather than by eye. This package is the one place that may
// depend on both.
const _absenceIsAPort = (
  proof: AuthenticatedRosterAbsence,
): ConformanceAuthenticatedRosterAbsence => proof
const _absenceCoversPort = (
  proof: ConformanceAuthenticatedRosterAbsence,
): AuthenticatedRosterAbsence => proof
const _capturedIsAPort = (
  port: CapturedRecoveryPort,
): ConformanceCapturedRecoveryPort<LogPosition> => port
const _capturedCoversPort = (
  port: ConformanceCapturedRecoveryPort<LogPosition>,
): CapturedRecoveryPort => port
const _cryptoIsAPort = (crypto: GroupCrypto): ConformanceCryptoMember['crypto'] => crypto
const _mlsIsAPort = (mls: GroupMLS): ConformanceMLSMember['mls'] => mls

// THE TRIPWIRE, and the reverse direction is the whole point of it. The assignments above only
// prove the suite asks for nothing the port lacks; they say nothing about a port member the suite
// has never heard of. That gap is invisible by construction — a member with no clause produces no
// failure — and it was real: eight of `GroupMLS`'s twelve members had no contract at all, across
// the recovery and ledger lanes, which carry the group's whole authority state.
//
// These assignments fail to compile the moment a port grows a member the conformance shape does
// not carry. Adding one is then a decision — write the clause, or widen the shape and say why it
// has none — rather than something that happens silently.
const _cryptoCoversPort = (crypto: ConformanceCryptoMember['crypto']): GroupCrypto => crypto
const _mlsCoversPort = (mls: ConformanceGroupMLS<LogPosition>): GroupMLS => mls

testGroupCryptoConformance({
  label: 'createGroupCrypto over a real GroupHandle',
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `crypto-conformance-${id}`)
    let hintOffset = 0
    const accesses = group.members.map((member) =>
      (() => {
        const base = testHandleAccess({
          handle: () => member.handle,
          adopt: (next) => {
            member.handle = next
          },
        })
        return { ...base, epoch: () => base.epoch() + hintOffset }
      })(),
    )
    return {
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      members: accesses.map((access, index) => {
        const member = group.members[index]
        if (member == null) throw new Error('missing member')
        return { did: member.identity.id, crypto: createGroupCrypto({ access }) }
      }),
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        for (const access of accesses)
          await access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
      },
      removeMember: async (index) => {
        const commit = await buildRealCommit(group, { removes: index })
        for (const [at, access] of accesses.entries()) {
          if (at === index) continue
          await access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
        }
      },
    }
  },
})

testPendingGroupCryptoConformance({
  label: 'createGroupCrypto over a real GroupHandle',
  isStorageError: isAppFrameStorageError,
  createFixture: async (id) => {
    const group = await createRealGroup(1, `pending-${id}`)
    const member = group.members[0]
    if (member == null) throw new Error('missing real group member')
    const originalHandle = member.handle
    let persistCalls = 0
    const store = {
      state: encodeClientState(member.handle.state),
      revision: 0,
      records: new Map<string, PendingAppFrame>(),
      fail: false,
    }
    const pending = {
      persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
        persistCalls++
        if (store.fail) throw new Error('database unavailable')
        store.state = state.slice()
        store.revision += 1
        store.records.set(record.frame.id, record)
      },
      list: async () => [...store.records.values()],
      complete: async (recordID: string) => {
        store.records.delete(recordID)
      },
    }
    const receiver = createGroupCrypto({
      access: testHandleAccess({
        handle: () => member.handle,
        stateVersion: () => store.revision,
        adopt: (next) => {
          member.handle = next
        },
      }),
      pending,
    })
    const restore = async () => {
      const state = decodeClientState(store.state)
      if (state == null) throw new Error('invalid saved state')
      const handle = await restoreGroup({
        state,
        credential: member.handle.credential,
        ledgerEntries: member.handle.ledgerTokens,
        options: { resolveLedgerEntries: member.slot.resolve },
      })
      const access = testHandleAccess({
        handle: () => handle,
        adopt: () => {},
        stateVersion: () => store.revision,
      })
      expect((await access.readControl(async (scope) => scope.source)).stateVersion).toBe(
        store.revision,
      )
      return createGroupCrypto({ access, pending })
    }
    return {
      senderDID: group.committer.identity.id,
      sender: createGroupCrypto({
        access: testHandleAccess({
          handle: () => group.committer.handle,
          adopt: (next) => {
            group.committer.handle = next
          },
        }),
      }),
      receiver,
      restore,
      failPersist: (yes: boolean) => {
        store.fail = yes
      },
      saveHandle: async () => {
        store.state = encodeClientState(member.handle.state)
        store.revision += 1
      },
      liveContextOwned: () => member.handle === originalHandle,
      liveState: () => encodeClientState(member.handle.state),
      persistCalls: () => persistCalls,
      unnamedSender: () => {
        const leafIndex = member.handle
          .listMembers()
          .find((entry) => entry.id === group.committer.identity.id)?.leafIndex
        if (leafIndex == null) throw new Error('missing sender leaf')
        const node = member.handle.state.ratchetTree[leafIndex * 2]
        if (
          node == null ||
          node.nodeType !== nodeTypes.leaf ||
          !('identity' in node.leaf.credential)
        )
          throw new Error('missing credential')
        const credential = node.leaf.credential
        const original = credential.identity
        credential.identity = new TextEncoder().encode('not-json-garbage')
        return () => {
          credential.identity = original
        }
      },
      advance: async () => {
        const commit = await buildRealCommit(group, {})
        await member.handle.processMessage(commit)
      },
    }
  },
})

testGroupMLSConformance({
  createCapturedRecovery: () => createCapturedRealRecovery(),
  label: 'createGroupMLS over a real GroupHandle',
  createBoundRecovery: createRealBoundRecovery,
  createGroup: async (size, id) => {
    const group = await createRealGroup(size, `mls-conformance-${id}`)
    let hintOffset = 0
    const stores = group.members.map((member) => createTransactionalStore(member.handle))
    return {
      buildUnavailableCommit: () => buildRealUnavailableCommit(group),
      readEvidence: (index) => {
        const store = stores[index]
        if (store === undefined) throw new Error('missing store')
        return store.readEvidence()
      },
      groupID: group.committer.handle.groupID,
      restartMember: async (index) => {
        const member = group.members[index]
        const store = stores[index]
        if (member == null || store == null) throw new Error('missing member')
        const row = store.snapshot()
        const state = decodeClientState(row.state)
        if (state == null) throw new Error('bad stored state')
        let handle = await restoreGroup({
          state,
          credential: member.handle.credential,
          ledgerEntries: row.ledger,
          options: { resolveLedgerEntries: member.slot.resolve },
        })
        return {
          did: member.identity.id,
          mls: createGroupMLS({
            identity: member.identity,
            entrySlot: member.slot,
            ...testGroupMLSDependencies(
              persistedTestAccess(
                {
                  handle: () => handle,
                  adopt: (next) => {
                    handle = next
                  },
                },
                store,
              ),
            ),
          }),
        }
      },
      otherGroupMember: async (index) => {
        const member = group.members[index]
        if (member == null) throw new Error('missing member')
        const other = await createRealGroup(1, `other-${id}`, [member.identity])
        const joined = other.members[0]
        if (joined == null) throw new Error('missing other member')
        return {
          did: joined.identity.id,
          mls: createGroupMLS({
            identity: joined.identity,
            entrySlot: joined.slot,
            ...testGroupMLSDependencies(
              persistedTestAccess({
                handle: () => joined.handle,
                adopt: (next) => {
                  joined.handle = next
                },
              }),
            ),
          }),
        }
      },
      confirmationTag,
      buildRotation: async (index) => {
        const member = group.members[index]
        if (member == null) throw new Error('missing member')
        return await buildRealRotation(member.handle)
      },
      pauseNextSave: (index, pause) => {
        const store = stores[index]
        if (store == null) throw new Error('missing store')
        store.beforeWrite = async () => {
          store.beforeWrite = undefined
          await pause()
        }
      },
      sealVerdictPayload: async (index, request, verdict) => {
        const member = group.members[index]
        if (member == null) throw new Error('missing member')
        return await sealRealRecoveryVerdict(member, request, verdict)
      },
      setEpochHintOffset: (offset) => {
        hintOffset = offset
      },
      committerDID: group.committer.identity.id,
      members: group.members.map((member, index) => ({
        did: member.identity.id,
        mls: createGroupMLS({
          ...testGroupMLSDependencies(
            (() => {
              const store = stores[index]
              if (store == null) throw new Error('missing store')
              const base = testHandleAccess({
                stateVersion: () => store.snapshot().revision,
                handle: () => member.handle,
                adopt: (next) => {
                  member.handle = next
                },
                persist: (handle, write) =>
                  store.save(
                    store.snapshot().revision,
                    encodeClientState(handle.state),
                    handle.ledgerTokens,
                    undefined,
                    write,
                  ),
              })
              return { ...base, epoch: () => base.epoch() + hintOffset }
            })(),
            stores[index]?.control,
          ),
          identity: member.identity,
          entrySlot: member.slot,
        }),
      })),
      buildCommit: async (options) => ({
        commit: await buildRealCommit(group, options ?? {}),
        context: {
          senderDID: group.committer.identity.id,
          resolveLedgerEntries: group.resolveLedgerEntries,
        },
      }),
      buildExternalCommit: async (params) => await buildRealExternalCommit(group, params),
    }
  },
})

test('real captured port exposes bound fork authority', async () => {
  const fixture = await createCapturedRealRecovery()
  expect(typeof fixture.requester.capturedRecovery?.authoriseForkRecovery).toBe('function')
})

for (const ownership of ['supplied', 'absent'] as const) {
  testForkRecoveryConformance({
    label: `real MLS / direct / ownership ${ownership}`,
    createFixture: () => createForkRecoveryRealFixture(false, { ownership }),
  })
}

test('real responder emits v3 lineage bounded to requested span', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    const capture = await f.reply()
    const reply = await f.inspect(capture)
    expect(reply?.version).toBe(3)
    expect(reply?.lineage?.map((frame) => decodeEpochCheckpoint(frame).body.epoch)).toEqual([
      10, 11, 12,
    ])
    expect(capture.sealed.byteLength).toBeLessThanOrEqual(786432)
  } finally {
    await f.close()
  }
})

for (const transactional of [false, true]) {
  test.each([null, 'built', 'published', 'confirmed', 'adopted'] as const)(
    `real adapters heal no X and saved X without capability replacement / transactional ${transactional}: %s`,
    async (stage) => {
      const f = await createForkRecoveryRealFixture(transactional)
      try {
        if (stage !== null) await f.saveX(stage)
        const before = await f.snapshot()
        const port = f.requester().capturedRecovery
        const capture = await f.reply()
        const authority = await port?.authoriseForkRecovery?.(capture, f.noticeID)
        if (authority == null) throw new Error('Missing real authority')
        const y = await f.build(authority, capture)
        if (y === null) throw new Error('Missing authorised Y')
        const result = await f.installY(y)
        expect(result.applied).toMatchObject({ applied: true, advanced: true, epochAfter: 13 })
        expect(result.destination.incarnation).toBe(result.sourceKey.incarnation + 1)
        expect(result.ordinaryFloor).toBe(before.recoveryEpochFloor)
        expect(
          (await f.local().device.groups.ports(result.sourceKey).control.load())
            .forkRecoveryAttempt,
        ).toBeNull()
      } finally {
        await f.close()
      }
    },
  )
}

test.each(['built', 'published'] as const)(
  'restore rechecks own lineage capture above E after restart with Y %s',
  async (stage) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      await f.saveX()
      const authority = await f
        .requester()
        .capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID)
      if (authority == null) throw new Error('Missing authority')
      const hostile = await f.seedOwnY(authority, stage)
      const before = await f.snapshot()
      await f.restart()
      await expect(
        f.requester().capturedRecovery?.restoreRecovery(hostile.candidate, hostile.requestKey),
      ).rejects.toThrow('target-behind')
      expect(await f.snapshot()).toEqual(before)
    } finally {
      await f.close()
    }
  },
)

test('retained-range hole grants no transcript exception', async () => {
  const f = await createForkRecoveryRealFixture(true, { holes: [12] })
  try {
    await f.saveX()
    const before = await f.snapshot()
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(await f.reply(), f.noticeID),
    ).toBeNull()
    expect(await f.snapshot()).toEqual(before)
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(await f.reply(13), f.noticeID),
    ).toMatchObject({ splitEpoch: 10 })
  } finally {
    await f.close()
  }
})

test('lower floor and authorise switch commit together', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const before = await f.snapshot()
    const reply = await f.reply()
    f.local().armNextWorkFault('before-commit')
    await expect(
      f.requester().capturedRecovery?.authoriseForkRecovery?.(reply, f.noticeID),
    ).rejects.toThrow()
    expect(await f.snapshot()).toEqual(before)
    expect(
      (await f.service().readRecords()).filter((row) => row.kind === 'superseded-rejoin'),
    ).toEqual([])
  } finally {
    await f.close()
  }
})

test.each(['closed', 'equivocation', 'wrong-split', 'wrong-hash'] as const)(
  'closed or unproven notice cannot lower floor: %s',
  async (change) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      await f.saveX()
      const capture = await f.reply()
      await f.rewriteNotice((notice) => {
        if (change === 'closed') notice.closedAt = Date.now()
        if (change === 'equivocation')
          notice.equivocations = notice.branches.flatMap((branch) => branch.signers)
        if (change === 'wrong-split') notice.splitEpoch = 11
        if (change === 'wrong-hash')
          for (const branch of notice.branches) branch.authHash = notice.deviceAuthHash
      })
      const before = await f.snapshot()
      expect(
        await f.requester().capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID),
      ).toBeNull()
      expect(await f.snapshot()).toEqual(before)
    } finally {
      await f.close()
    }
  },
)

test('heal after evidence expiry stays target behind', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const before = await f.snapshot()
    const capture = await f.reply()
    await f.expireEvidence()
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID),
    ).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  } finally {
    await f.close()
  }
})

test('fork floor expires with its attempt', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const capture = await f.reply()
    const authority = await f
      .requester()
      .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
    if (authority == null) throw new Error('Missing authority')
    const y = await f.build(authority, capture)
    if (y === null) throw new Error('Missing authorised Y')
    await f.installY(y)
    await f.restart()
    const snapshot = await f.snapshot()
    expect(snapshot.forkRecoveryAttempt).toBeNull()
    expect(snapshot.recoveryEpochFloor).toBe(20)
    const lower = await f.reply()
    await expect(
      f
        .requester()
        .capturedRecovery?.applyRecovery(lower.sealed, lower.requestID, lower.requestKey),
    ).rejects.toMatchObject({ name: 'RecoveryTargetBehindError' })
  } finally {
    await f.close()
  }
})

test.each(['commit', 'rollback'] as const)(
  'lower floor and authorise switch expose no change before proof: %s',
  async (outcome) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      await f.saveX()
      const before = await f.snapshot()
      const reply = await f.reply()
      const port = f.requester().capturedRecovery
      if (port?.authoriseForkRecovery === undefined) throw new Error('Missing authority method')
      const fault = f.local().armNextWorkFault('pending')
      let authorityReturned = false
      const attempt = port.authoriseForkRecovery(reply, f.noticeID).then((value) => {
        authorityReturned = true
        return value
      })
      void attempt.catch(() => {})
      await fault.rejected
      expect(authorityReturned).toBe(false)
      expect(f.builds()).toBe(0)
      let observed = false
      const reading = f.snapshot().then((snapshot) => {
        observed = true
        return snapshot
      })
      await Promise.resolve()
      expect(observed).toBe(false)
      await fault.finish(outcome)
      if (outcome === 'rollback') {
        await expect(attempt).rejects.toThrow()
        expect(await reading).toEqual(before)
      } else {
        expect(await attempt).toMatchObject({ splitEpoch: 10 })
        expect(await reading).toMatchObject({
          rejoin: null,
          recoveryEpochFloor: 20,
          forkRecoveryAttempt: { forkRecovery: { splitEpoch: 10 } },
        })
      }
    } finally {
      await f.close()
    }
  },
)

test('earlier-moving notice re-enables fork recovery authorisation', async () => {
  const f = await createForkRecoveryRealFixture(true, { noticeEpoch: 11 })
  try {
    await f.saveX()
    const capture = await f.reply(10)
    const before = await f.snapshot()
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID),
    ).toBeNull()
    expect(await f.snapshot()).toEqual(before)
    await f.moveNoticeEarlier()
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID),
    ).toMatchObject({ splitEpoch: 10 })
  } finally {
    await f.close()
  }
})

test('evidence expiry between confirmation and switch stays target behind', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const capture = await f.reply()
    const authority = await f
      .requester()
      .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
    if (authority == null) throw new Error('Missing authority')
    const y = await f.build(authority, capture)
    if (y === null) throw new Error('Missing Y')
    await f.expireEvidence()
    await expect(f.installY(y)).rejects.toMatchObject({ name: 'RecoveryTargetBehindError' })
    expect((await f.local().device.groups.load(f.key.groupID))?.activeIncarnation).toBe(1)
    expect(await f.snapshot()).toMatchObject({
      recoveryEpochFloor: 20,
      forkRecoveryAttempt: { id: authority.attemptID },
      rejoin: { id: authority.attemptID, stage: 'confirmed' },
    })
  } finally {
    await f.close()
  }
})

test.each(['notice', 'request', 'key', 'lineage'] as const)(
  'wrong branch checkpoint or reply signer cannot lower floor: %s binding',
  async (field) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      await f.saveX()
      const capture = await f.reply()
      const before = await f.snapshot()
      if (field === 'request') capture.requestID = crypto.randomUUID()
      if (field === 'key') capture.requestKey = crypto.getRandomValues(new Uint8Array(32))
      if (field === 'lineage') {
        const last = capture.sealed.at(-1)
        if (last === undefined) throw new Error('Missing sealed bytes')
        capture.sealed[capture.sealed.length - 1] = last ^ 1
      }
      expect(
        await f
          .requester()
          .capturedRecovery?.authoriseForkRecovery?.(
            capture,
            field === 'notice' ? 'unproven-notice' : f.noticeID,
          ),
      ).toBeNull()
      expect(await f.snapshot()).toEqual(before)
    } finally {
      await f.close()
    }
  },
)

test('checkpoint intake alone cannot start recovery', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const before = await f.snapshot()
    await f.importEarlier()
    expect(await f.snapshot()).toEqual(before)
    expect(f.builds()).toBe(0)
  } finally {
    await f.close()
  }
})

test('equivocation only notice grants no floor authority even with an unproven summary', async () => {
  const f = await createForkRecoveryRealFixture(true)
  try {
    await f.saveX()
    const capture = await f.reply()
    await f.equivocationOnly()
    const before = await f.snapshot()
    expect(
      await f.requester().capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID),
    ).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  } finally {
    await f.close()
  }
})

test.each(['built', 'adopted'] as const)(
  'superseding X preserves prior outcomes and cumulative obligations: %s',
  async (stage) => {
    const f = await createForkRecoveryRealFixture(true)
    try {
      await f.saveX()
      const record = (await f.snapshot()).rejoin
      if (record === null || !('format' in record)) throw new Error('Missing saved X')
      const source = record.source.key
      const outcomes = [
        {
          id: 'already-landed',
          opID: 'sent-operation',
          at: 1,
          kind: 'landed' as const,
          position: 'accepted-position' as LogPosition,
        },
        { id: 'already-unknown', opID: 'unknown-operation', at: 2, kind: 'unknown' as const },
      ]
      await f.local().installRows({
        key: source,
        control: {
          putOutcomes: outcomes,
          putSettledRejoins: [
            {
              id: 'earlier-settlement',
              kind: 'not-accepted',
              epoch: 20,
              origin: { sourceKey: source, target: record.target, searchFrom: record.searchFrom },
              ledgerBefore: ['earlier-owed', 'shared'],
            },
          ],
        },
      })
      if (stage === 'adopted') await f.saveX('adopted')
      const capture = await f.reply()
      const authority = await f
        .requester()
        .capturedRecovery?.authoriseForkRecovery?.(capture, f.noticeID)
      if (authority == null) throw new Error('Missing authority')
      expect((await f.local().device.groups.ports(source).control.load()).outcomes).toEqual(
        outcomes,
      )
      const snapshot = await f.snapshot()
      expect(snapshot.settledRejoins[0]).toMatchObject({ kind: 'superseded-branch', epoch: 10 })
      expect(new Set(snapshot.settledRejoins[0]?.ledgerBefore)).toEqual(
        new Set(['earlier-owed', 'shared', 'owed-X']),
      )
      const y = await f.build(authority, capture)
      expect(new Set(y?.record.ledgerBefore)).toEqual(new Set(['earlier-owed', 'shared', 'owed-X']))
    } finally {
      await f.close()
    }
  },
)
