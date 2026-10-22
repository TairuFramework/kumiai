import { decodeClientState, encodeClientState } from '@kumiai/mls'
import type { ControlChanges } from '@kumiai/rpc'
import {
  controlConsumptionRecords,
  testControlConsumptionConformance,
} from '@kumiai/rpc-conformance'
import { describe, expect } from 'vitest'

import { createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createControlCrashHarness } from './fixtures/storage-persistence.js'
import {
  makeStorageSeed,
  nextChange,
  writeInstallationCheckpoint,
} from './fixtures/storage-seed.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

for (const mode of ['real-mls', 'double'] as const) {
  describe(`root provider source closure / ${mode}`, () => {
    testControlConsumptionConformance({
      prepare: async (work) => {
        const h = await createControlCrashHarness(mode)
        let candidate: Uint8Array | undefined
        if (work === 'build') {
          const built = await h.build()
          candidate = decodeControlJournal(built.slot.journal).candidate
          expect(
            await createPersistenceBuildSaver({ persistence: h.groups, key: h.key })(
              built.intent,
              built.slot,
              built.expected,
              'build',
            ),
          ).toBe('saved')
        } else await h.control.apply(controlConsumptionRecords(work) as ControlChanges, 'pending')
        return {
          snapshot: () => h.fixture.inspectRows(),
          consume: async (transition, write) => {
            const destination =
              transition === 'retire'
                ? await makeStorageSeed({ id: h.key.groupID, incarnation: 2, epoch: 0, mode })
                : null
            await h.groups.transition(
              await nextChange(h.groups, h.key.groupID, 'unclosed'),
              async (stores) => {
                const rows = stores.incarnation(1)
                if (destination !== null) {
                  const life = await stores.lifetime.load()
                  const trust = await stores.trust.load()
                  if (life === null || trust === null) throw new Error('Missing lifetime or trust')
                  await stores.lifetime.save({
                    ...life,
                    latestIncarnation: 2,
                    activeIncarnation: 2,
                    revision: life.revision + 1,
                    mutationID: 'unclosed',
                  })
                  await stores.incarnation(2).state.save(destination.state)
                  await stores.trust.save({
                    ...destination.trust,
                    genesisAnchor: trust.genesisAnchor,
                    spentEpochAuthenticators: trust.spentEpochAuthenticators,
                  })
                  await writeInstallationCheckpoint(stores, {
                    key: destination.key,
                    confirmedTranscriptHash: destination.confirmedTranscriptHash,
                    mutationID: 'unclosed',
                    stateVersion: destination.state.version,
                  })
                } else {
                  const state = await rows.state.load()
                  if (state === null || state.deleted) throw new Error('Missing state')
                  const decoded = candidate === undefined ? undefined : decodeClientState(candidate)
                  await rows.state.save({
                    ...state,
                    version: state.version + 1,
                    ...(transition === 'terminal'
                      ? { terminal: true }
                      : {
                          epoch: state.epoch + 1,
                          state: candidate ?? state.state,
                          epochAuthenticator:
                            decoded?.keySchedule.epochAuthenticator ?? state.epochAuthenticator,
                        }),
                  })
                }
                if (write) await rows.control.apply({}, 'unclosed')
              },
            )
          },
          close: () => h.fixture.close(),
        }
      },
    })
  })
}

describe('transactional access double source closure', () => {
  testControlConsumptionConformance({
    // This double has a fixed incarnation and no lifetime-switch port.
    retirement: false,
    prepare: async (work) => {
      const h = await createControlCrashHarness('real-mls')
      const built = await h.build()
      const group = await createRealGroup(1, 'transactional-closure')
      const member = group.members[0]
      if (member === undefined) throw new Error('Missing member')
      const store = createTransactionalStore(member.handle)
      if (work === 'build') {
        await store.control.apply({ putOperations: [built.intent] }, 'intent')
        const source = (await store.readEvidence()).source
        if (source.identity === null) throw new Error('Missing identity')
        expect(
          await store.saveBuilt(
            built.intent,
            {
              ...built.slot,
              epoch: source.identity.epoch,
              authenticatorBefore: source.identity.authenticator,
            },
            source,
            'build',
          ),
        ).toBe('saved')
      } else await store.control.apply(controlConsumptionRecords(work) as ControlChanges, 'pending')
      return {
        snapshot: async () => (await store.fork()).snapshot(),
        consume: async (transition, write) => {
          const row = store.snapshot()
          const state = decodeClientState(row.state)
          if (state === undefined) throw new Error('Missing state')
          if (transition === 'terminal') state.groupActiveState = { kind: 'removedFromGroup' }
          else state.groupContext.epoch++
          await store.save(
            row.revision,
            encodeClientState(state),
            row.ledger,
            undefined,
            write ? { mutationID: 'unclosed', changes: {} } : undefined,
          )
        },
        close: () => h.fixture.close(),
      }
    },
  })
})
