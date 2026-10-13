import { commitKeyRotation, decodeClientState, encodeClientState, restoreGroup } from '@kumiai/mls'
import {
  type AdoptionWrite,
  asLogPosition,
  type ControlSlot,
  forkEventID,
  type Operation,
  recoveryUnavailableEventID,
  type SafetyHold,
} from '@kumiai/rpc'
import { runControlSafetyContract } from '@kumiai/rpc-conformance'
import { describe } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createControlAdoptionPort } from '../src/control-adoption.js'
import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { encodeControlJournal } from '../src/control-journal.js'
import { createMemoryGroupPersistence } from '../src/memory-group-persistence.js'
import { createMemoryTransaction } from '../src/memory-transaction.js'
import { createOwnerQueues } from '../src/owner-queue.js'
import { createDeterministicAtRestCodec } from './fixtures/at-rest.js'
import { installSeed, makeStorageSeed, nextChange } from './fixtures/storage-seed.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

async function safetyHost(mode: 'real' | 'transactional', id: string) {
  const key = { groupID: id, incarnation: 1 }
  const seed = await makeStorageSeed({ id, incarnation: 1, epoch: 0, mode: 'real-mls' })
  if (seed.state.state === null) throw new Error('Missing seed')
  const decoded = decodeClientState(seed.state.state)
  if (decoded === undefined) throw new Error('Invalid state')
  let handle = await restoreGroup({
    state: decoded,
    credential: seed.trust.credential,
    ledgerEntries: seed.state.ledger,
  })
  const db = createMemoryTransaction({ rows: {} })
  const groups = createMemoryGroupPersistence({
    db,
    owners: createOwnerQueues(),
    providerID: id,
    atRest: createDeterministicAtRestCodec({ key: new Uint8Array(32).fill(71) }),
  })
  await installSeed(groups, seed, 'seed')
  const transactional = createTransactionalStore(handle)
  const control = mode === 'real' ? groups.ports(key).control : transactional.control
  const version = async () =>
    mode === 'real'
      ? ((await groups.loadState(key))?.version ?? 0)
      : transactional.snapshot().revision
  const access = simpleHandleAccess({
    key,
    handle: () => handle,
    stateVersion: version,
    adopt: (next) => {
      handle = next
    },
    persist: async (next, write) => {
      if (mode === 'transactional') {
        await transactional.save(
          await version(),
          encodeClientState(next.state),
          next.ledgerTokens,
          undefined,
          write,
        )
        return
      }
      const previous = await groups.loadState(key)
      const trust = await groups.loadTrust(id)
      if (previous === null || previous.deleted || trust === null) throw new Error('Missing source')
      const state = {
        ...previous,
        version: previous.version + 1,
        epoch: Number(next.epoch),
        epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
        state: encodeClientState(next.state),
        ledger: next.ledgerTokens,
      }
      await groups.transition(
        await nextChange(groups, id, write?.mutationID ?? crypto.randomUUID()),
        async (stores) => {
          await stores.incarnation(1).state.save(state, write?.expected)
          await stores.trust.save({
            ...trust,
            installed: { ...key, epoch: state.epoch, authenticator: state.epochAuthenticator },
          })
          if (write !== undefined)
            await stores.incarnation(1).control.apply(write.changes, write.mutationID)
        },
      )
    },
  })
  const intent: Operation & { stage: 'intent' } = {
    id: 'rotation',
    kind: 'rotation',
    revokes: false,
    body: new Uint8Array(),
    seq: 1,
    enqueuedAt: 0,
    deadline: Number.MAX_SAFE_INTEGER,
    stage: 'intent',
  }
  await control.apply({ putOperations: [intent] }, 'intent')
  const source = () => access.readControl(async (scope) => scope.source)
  const rotation = await commitKeyRotation(handle)
  const original = await source()
  const candidate = encodeClientState(rotation.newGroup.state)
  const slot: ControlSlot = {
    opID: intent.id,
    incarnation: 1,
    epoch: 0,
    authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
    searchFrom: null,
    expectedHead: null,
    publishID: 'rotation',
    payload: rotation.commitMessage,
    payloadDigest: 'rotation-payload',
    digest: 'rotation-commit',
    bodies: [],
    welcome: null,
    journal: encodeControlJournal({
      version: 1,
      source: original,
      checkpoint: null,
      sourceState: encodeClientState(handle.state),
      sourceCredential: handle.credential,
      sourceLedger: handle.ledgerTokens,
      candidate,
    }),
  }
  const saver =
    mode === 'real'
      ? createPersistenceBuildSaver({ persistence: groups, key })
      : transactional.saveBuilt
  let cryptoCalls = 0
  const build = createControlBuildPort({
    access,
    control,
    saveBuilt: saver,
    now: Date.now,
    newID: () => crypto.randomUUID(),
    build: async () => {
      cryptoCalls++
      return {
        epoch: 0,
        incarnation: 1,
        authenticatorBefore: slot.authenticatorBefore,
        commit: rotation.commitMessage,
        digest: slot.digest,
        bodies: [],
        welcome: null,
        journal: candidate,
      }
    },
  })
  const adoption = createControlAdoptionPort({
    access,
    control,
    restoreCandidate: async (bytes) => {
      cryptoCalls++
      const state = decodeClientState(bytes)
      if (state === undefined) throw new Error('Invalid candidate')
      return restoreGroup({
        state,
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
      })
    },
  })
  const prepareBuild = () =>
    build.prepareBuild(intent, async () => ({
      payload: slot.payload,
      publishID: slot.publishID,
      expectedHead: null,
    }))
  const saveBuilt = () =>
    source().then((expected) => saver(intent, slot, expected, crypto.randomUUID()))
  const prepareAdoption = async () => {
    if ((await saveBuilt()) !== 'saved') throw new Error('Invalid prepared build')
    const proof = {
      source: await source(),
      from: null,
      position: asLogPosition('1'),
      payloadDigest: slot.payloadDigest,
    }
    await control.apply({ commitOnceAcceptance: proof }, 'accept')
    const write: AdoptionWrite = {
      mutationID: 'adopt',
      changes: {
        commitOnce: null,
        deleteOperations: [intent.id],
        putApplied: [
          {
            epoch: 0,
            digest: slot.digest,
            payloadDigest: slot.payloadDigest,
            sequenceID: proof.position,
            opID: intent.id,
            removed: false,
          },
        ],
        cursor: { position: proof.position, epoch: 1 },
      },
    }
    return async () =>
      adoption.adopt(slot.journal, { ...(await source()), acceptance: proof }, write)
  }
  return {
    control,
    prepareBuild,
    saveBuilt,
    prepareAdoption,
    hold: async (reason: NonNullable<SafetyHold>) =>
      control.apply(
        reason === 'fork-halted'
          ? {
              forkHalt: {
                eventID: forkEventID(key),
                detectedAt: 1,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 0,
                  position: '1',
                  digest: 'foreign',
                },
              },
            }
          : {
              recoveryUnavailable: {
                ...key,
                id: recoveryUnavailableEventID(key),
                kind: 'group:recovery-unavailable',
                reason: 'trust-unreadable',
              },
            },
        'hold',
      ),
    snapshot: async () => {
      const stored = await groups.loadState(key)
      return {
        control: await control.load(),
        state:
          mode === 'real'
            ? stored !== null && !stored.deleted
              ? stored.state
              : null
            : transactional.snapshot().state,
        version: await version(),
      }
    },
    cryptoCalls: () => cryptoCalls,
  }
}

for (const mode of ['real', 'transactional'] as const) {
  describe(`${mode} persistence, build and adoption safety`, () => {
    let build: Awaited<ReturnType<typeof safetyHost>>
    let adoption: Awaited<ReturnType<typeof safetyHost>>
    let adopt: Awaited<ReturnType<typeof adoption.prepareAdoption>>
    runControlSafetyContract({
      prepareValid: async () => {
        build = await safetyHost(mode, `safety-build-${mode}`)
        adoption = await safetyHost(mode, `safety-adopt-${mode}`)
        adopt = await adoption.prepareAdoption()
      },
      hold: async (reason) => {
        await build.hold(reason)
        await adoption.hold(reason)
      },
      prepareBuild: async () =>
        (await build.prepareBuild()).kind === 'saved' ? 'changed' : 'refused',
      saveBuilt: async () => ((await build.saveBuilt()) === 'saved' ? 'changed' : 'refused'),
      adopt: async () => ((await adopt()) === 'installed' ? 'changed' : 'refused'),
      // Include both actual stores so a refusal cannot hide changes in either boundary.
      snapshot: async () => {
        const left = await build.snapshot()
        const right = await adoption.snapshot()
        return {
          control: left.control,
          state: new TextEncoder().encode(JSON.stringify([left, right])),
          version: left.version + right.version,
        }
      },
      cryptoCalls: () => build.cryptoCalls() + adoption.cryptoCalls(),
    })
  })
}
