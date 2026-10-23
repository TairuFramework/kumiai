import { randomIdentity } from '@kokuin/token'
import {
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  encodeGroupAnchor,
  ROLE_ENTRY_TYPE,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  asLogPosition,
  type ControlSnapshot,
  decodeCommitFrame,
  decodeHandshakeFrame,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { afterEach, expect, test, vi } from 'vitest'

import { deriveEntryKey, sealEntries } from '../src/crypto.js'
import { decodeStoredValue } from '../src/persistence-codec.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createRealGroup } from './fixtures/real-group.js'
import { restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'
import { createControlCrashHarness } from './fixtures/storage-persistence.js'
import { makeStorageSeed } from './fixtures/storage-seed.js'

const { tagMemoryCommit, decodeMemoryCommit } = (await import(
  new URL('../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  decodeMemoryCommit(commit: Uint8Array): Record<string, unknown> | null
  tagMemoryCommit(commit: Uint8Array, authenticator: Uint8Array): Uint8Array
}

async function foreignHarness(mode: 'double' | 'real-mls', context = false) {
  const ownership = context ? createAsyncLocalOwnershipContext() : undefined
  if (mode === 'double')
    return { h: await createControlCrashHarness(mode, undefined, ownership, true) }
  const real = await createRealGroup(3, 'control-crash')
  const competitor = real.members[0]
  if (competitor === undefined) throw new Error('Missing competitor')
  const role = await signLedgerEntry(real.committer.identity, {
    type: ROLE_ENTRY_TYPE,
    groupID: 'control-crash',
    subject: competitor.identity.id,
    value: 'admin',
  })
  const granted = await commitLedgerEntries(real.committer.handle, [role])
  real.committer.handle = granted.newGroup
  for (const member of real.members) {
    member.slot.install(async () => [role])
    await member.handle.processMessage(granted.commitMessage)
  }
  const handle = real.committer.handle
  const epoch = Number(handle.epoch)
  const seed = await makeStorageSeed({ id: 'control-crash', incarnation: 1, epoch, mode })
  seed.confirmedTranscriptHash = handle.state.groupContext.confirmedTranscriptHash.slice()
  seed.state = {
    ...seed.state,
    state: encodeClientState(handle.state),
    epochAuthenticator: handle.state.keySchedule.epochAuthenticator,
    credential: handle.credential,
    ledger: handle.ledgerTokens,
  }
  seed.trust = {
    ...seed.trust,
    genesisAnchor: encodeGroupAnchor(handle.anchor),
    installed: { ...seed.key, epoch, authenticator: handle.state.keySchedule.epochAuthenticator },
    signerTree: handle.state.ratchetTree,
    registry: handle.registry,
    credential: handle.credential,
    ledger: handle.ledgerTokens,
    spentEpochAuthenticators: [handle.state.keySchedule.epochAuthenticator],
  }
  return { h: await createControlCrashHarness(mode, seed, ownership, true), competitor }
}

afterEach(() => vi.useRealTimers())

for (const mode of ['double', 'real-mls'] as const) {
  test.each([false, true])(
    `valid consumption after a copy skip closes unknown and preserves owed obligations (${mode}, context=%s)`,
    async (context) => {
      const h = await createControlCrashHarness(
        mode,
        undefined,
        context ? createAsyncLocalOwnershipContext() : undefined,
        true,
      )
      try {
        await h.peer.resync()
        vi.useFakeTimers()
        const submit = h.hub.publish.bind(h.hub)
        vi.spyOn(h.hub, 'publish').mockRejectedValue(new Error('hub unavailable'))
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'saved')
        const owed = {
          opID: 'independent-welcome',
          welcome: new Uint8Array([3, 2, 1]),
          recipients: ['guest'],
        }
        await h.control.apply({ putWelcomes: [owed] }, 'independent-obligation')
        const frame = decodeCommitFrame(decodeHandshakeFrame(built.slot.payload).payload)
        await submit({
          topicID: await h.topic(),
          senderDID: h.localDID,
          retain: 'log',
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(frame.commit, new Uint8Array([99])),
          ),
        })
        await h.controlWalk.walkCommits()
        expect((await h.control.load()).welcomes).toEqual([owed])
        await submit({
          topicID: await h.topic(),
          senderDID: h.localDID,
          retain: 'log',
          payload: built.slot.payload,
        })
        await h.controlWalk.walkCommits()
        expect(await h.control.load()).toMatchObject({
          commitOnce: null,
          welcomes: [owed],
          outcomes: expect.arrayContaining([
            expect.objectContaining({ opID: built.slot.opID, kind: 'unknown' }),
          ]),
        })
        expect(h.observations.ownAdoptions).toBe(1)
        const reopened = await h.reopen()
        try {
          expect((await reopened.control.load()).welcomes).toEqual([owed])
          await reopened.peer.replay()
          await vi.waitFor(async () => expect((await reopened.control.load()).welcomes).toEqual([]))
          expect(h.observations.welcomeDeliveries).toBe(1)
        } finally {
          await reopened.close()
        }
      } finally {
        await h.close()
        await h.fixture.close()
      }
    },
  )

  test.each(
    [false, true].flatMap((context) =>
      ['own', 'foreign'].flatMap((owner) =>
        [false, true].flatMap((restart) =>
          ['corrupt', 'withheld', 'malformed', 'version', 'reference'].map((failure) => ({
            context,
            owner,
            restart,
            failure,
          })),
        ),
      ),
    ),
  )(
    `unreadable own and foreign copies preserve live invite material across restart (${mode}, $owner, $failure, restart=$restart, context=$context)`,
    async ({ owner, failure, restart, context }) => {
      const { h, competitor } =
        owner === 'foreign'
          ? await foreignHarness(mode, context)
          : {
              h: await createControlCrashHarness(
                mode,
                undefined,
                context ? createAsyncLocalOwnershipContext() : undefined,
                true,
              ),
              competitor: undefined,
            }
      try {
        await h.peer.resync()
        vi.useFakeTimers()
        const submit = h.hub.publish.bind(h.hub)
        const publish = vi.spyOn(h.hub, 'publish').mockRejectedValue(new Error('hub unavailable'))
        const built = await h.build()
        expect(await h.saveBuilt(built.intent, built.slot, built.expected, 'saved')).toBe('saved')
        const saved = built.slot
        const before = await h.control.load()
        expect(saved.welcome).not.toBeNull()
        const row = await h.groups.loadState(h.key)
        if (row === null || row.deleted || row.state === null) throw new Error('Missing source')
        const state = decodeClientState(row.state)
        if (state === undefined) throw new Error('Invalid source')
        const handle = await (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
          state,
          credential: row.credential,
          ledgerEntries: row.ledger,
        })
        const key = await deriveEntryKey(handle)
        const frame = decodeCommitFrame(decodeHandshakeFrame(saved.payload).payload)
        let blob: Uint8Array = frame.sealedEntries.slice()
        if (failure === 'corrupt') blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1
        else if (failure === 'withheld') blob = new Uint8Array()
        else if (failure === 'malformed') blob = sealEntries(key, new Uint8Array([1, 1]))
        else if (failure === 'version') blob = new Uint8Array([99])
        else blob = sealEntries(key, encodeLedgerEntries([]))
        key.fill(0)
        let delivered = frame.commit
        if (owner === 'foreign') {
          if (competitor === undefined) {
            const parsed = decodeMemoryCommit(frame.commit)
            if (parsed === null) throw new Error('Missing memory commit')
            delivered = tagMemoryCommit(
              new TextEncoder().encode(
                JSON.stringify({
                  ...parsed,
                  committerDID: 'foreign-member',
                  signerDID: 'foreign-member',
                }),
              ),
              row.epochAuthenticator,
            )
          } else {
            const token = await signLedgerEntry(competitor.identity, {
              type: 'note',
              groupID: h.key.groupID,
              subject: competitor.identity.id,
              value: 'foreign entry',
            })
            delivered = (await commitLedgerEntries(competitor.handle, [token])).commitMessage
          }
        }
        const occurrence = await submit({
          senderDID: randomIdentity().id,
          topicID: await h.topic(),
          retain: 'log',
          payload: encodeHandshakeFrame(HANDSHAKE_KIND.commit, encodeCommitFrame(delivered, blob)),
        })
        await h.controlWalk.walkCommits()
        const skipped = await h.control.load()
        expect(skipped.commitOnce?.retryForbidden).toBe(false)
        expect(skipped.commitOnce).toMatchObject({
          ...saved,
          expectedHead: occurrence.sequenceID,
          skipped: true,
          retryForbidden: false,
        })
        expect(skipped.cursor?.position).toBe(occurrence.sequenceID)
        expect(skipped.cursor?.stranded).not.toBe(true)
        expect(skipped.strand).toBeNull()
        expect(skipped.controlHold).toBeNull()
        expect(skipped.outcomes).toEqual(before.outcomes)
        expect(h.observations.ownAdoptions).toBe(0)
        expect(await h.groups.loadState(h.key)).toMatchObject({
          state: row.state,
          epoch: row.epoch,
          epochAuthenticator: row.epochAuthenticator,
        })
        const current = restart ? await h.reopen() : h
        try {
          expect((await current.control.load()).commitOnce).toEqual(skipped.commitOnce)
          const builds = h.observations.builds
          publish.mockImplementation(submit)
          if (restart) await current.peer.replay()
          else await current.controlWalk.stepOperation(saved.opID)
          expect(h.publications).toContainEqual(
            expect.objectContaining({
              payload: saved.payload,
              publishID: saved.publishID,
              expectedHead: occurrence.sequenceID,
            }),
          )
          await current.controlWalk.walkCommits()
          const consumed = await current.control.load()
          expect(consumed.commitOnce).toBeNull()
          expect(consumed.outcomes).toContainEqual(
            expect.objectContaining({ opID: saved.opID, kind: 'unknown' }),
          )
          expect(consumed.welcomes).toEqual([])
          expect(h.observations.builds).toBe(builds)
          expect(h.observations.ownAdoptions).toBe(1)
          expect(h.observations.welcomeDeliveries).toBe(0)
        } finally {
          await current.close()
        }
      } finally {
        await h.close()
        await h.fixture.close()
      }
    },
  )

  test.each(
    [false, true].flatMap((context) =>
      ['ahead', 'retention-gap', 'unprocessable-gap', 'held-ahead'].flatMap((reason) =>
        [false, true].map((incomplete) => ({ reason, incomplete, context })),
      ),
    ),
  )(
    `legacy delivery-stranded cursor resumes valid own consumption without advancing capture (${mode}, $reason, incomplete=$incomplete, context=$context)`,
    async ({ reason, incomplete, context }) => {
      const h = await createControlCrashHarness(
        mode,
        undefined,
        context ? createAsyncLocalOwnershipContext() : undefined,
        true,
      )
      try {
        await h.peer.resync()
        vi.useFakeTimers()
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'saved')
        await h.control.apply(
          {
            cursor: {
              position: null,
              epoch: built.slot.epoch,
              stranded: true,
              ...(incomplete ? { incomplete: true } : {}),
            },
            strand: {
              reason: (reason === 'held-ahead' ? 'ahead' : reason) as
                | 'ahead'
                | 'retention-gap'
                | 'unprocessable-gap',
            },
            ...(reason === 'held-ahead'
              ? {
                  controlHold: {
                    reason: 'unsupported-version' as const,
                    position: asLogPosition('000000000000'),
                  },
                }
              : {}),
          },
          'legacy-delivery-strand',
        )
        const reopened = await h.reopen()
        try {
          const occurrence = await h.hub.publish({
            topicID: await reopened.topic(),
            senderDID: h.localDID,
            retain: 'log',
            payload: built.slot.payload,
          })
          await reopened.controlWalk.walkCommits()
          const after = await reopened.control.load()
          if (reason === 'unprocessable-gap' || reason === 'held-ahead') {
            expect(after.cursor?.stranded).toBe(true)
            expect(after.commitOnce).toEqual(built.slot)
          } else {
            expect(after.strand).toBeNull()
            expect(after.cursor).toMatchObject({
              position: occurrence.sequenceID,
              epoch: built.slot.epoch + 1,
            })
            expect(after.commitOnce).toBeNull()
            expect(after.outcomes).toContainEqual(
              expect.objectContaining({ opID: built.slot.opID, kind: 'unknown' }),
            )
            expect(after.welcomes).toEqual([])
          }
        } finally {
          await reopened.close()
        }
        const again = await h.reopen()
        expect((await again.control.load()).cursor?.stranded).toBe(
          reason === 'unprocessable-gap' || reason === 'held-ahead' ? true : undefined,
        )
        await again.close()
      } finally {
        await h.close()
        await h.fixture.close()
      }
    },
  )

  test.each([false, true])(
    `copy skip cursor and coverage roll back together (${mode}, context=%s)`,
    async (context) => {
      const h = await createControlCrashHarness(
        mode,
        undefined,
        context ? createAsyncLocalOwnershipContext() : undefined,
        true,
      )
      try {
        await h.peer.resync()
        vi.useFakeTimers()
        const submit = h.hub.publish.bind(h.hub)
        vi.spyOn(h.hub, 'publish').mockRejectedValue(new Error('hub unavailable'))
        const built = await h.build()
        await h.saveBuilt(built.intent, built.slot, built.expected, 'saved')
        const frame = decodeCommitFrame(decodeHandshakeFrame(built.slot.payload).payload)
        const occurrence = await submit({
          topicID: await h.topic(),
          senderDID: h.localDID,
          retain: 'log',
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(frame.commit, new Uint8Array([99])),
          ),
        })
        const before = await h.control.load()
        h.fixture.onPhase('work', () => {
          throw new Error('rollback copy skip')
        })
        await expect(h.controlWalk.walkCommits()).rejects.toThrow('rollback copy skip')
        expect(await h.control.load()).toEqual(before)
        expect(h.observations.ownAdoptions).toBe(0)
        expect(h.observations.welcomeDeliveries).toBe(0)
        let atomicSeal = false
        h.fixture.observeCodec((kind, namespace, bytes) => {
          if (kind !== 'seal' || namespace !== 'control') return
          const { snapshot } = decodeStoredValue(bytes) as { snapshot: ControlSnapshot }
          if (snapshot.cursor?.position !== occurrence.sequenceID) return
          expect(snapshot.commitOnce).toMatchObject({
            ...built.slot,
            skipped: true,
            retryForbidden: false,
          })
          atomicSeal = true
        })
        await h.controlWalk.walkCommits()
        expect(atomicSeal).toBe(true)
        expect(await h.control.load()).toMatchObject({
          cursor: { position: asLogPosition(occurrence.sequenceID) },
          commitOnce: { ...built.slot, skipped: true, retryForbidden: false },
        })
      } finally {
        await h.close()
        await h.fixture.close()
      }
    },
  )
}
