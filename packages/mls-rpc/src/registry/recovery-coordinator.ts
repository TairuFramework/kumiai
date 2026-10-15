import {
  type CapturedRejoinRecord,
  controlSafetyHeld,
  type GroupKey,
  type StoredRejoinRecord,
} from '@kumiai/rpc'

import type { EntryCapability } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import { GroupStateConflictError, GroupStateUncertainError } from '../persistence-errors.js'
import type { GroupPersistence, GroupTransaction } from '../persistence-types.js'
import { decodeCapturedRecoveryCandidate } from '../recovery-codec.js'
import { readRetainedTrust } from './safety.js'
import type { GroupHandleRegistry } from './types.js'

export type RecoverySwitchResolution =
  | { kind: 'committed'; destination: GroupKey }
  | { kind: 'rolled-back' | 'pending' }
export type RegistryRecoveryCoordinator = {
  readRecoveryRecord(key: GroupKey): Promise<StoredRejoinRecord | null>
  assignSwitchID(record: CapturedRejoinRecord): Promise<void>
  resolveRecoverySwitch(record: CapturedRejoinRecord): Promise<RecoverySwitchResolution>
}
const coordinators = new WeakMap<GroupHandleRegistry, RegistryRecoveryCoordinator>()
export function registryRecoveryCoordinator(
  registry: GroupHandleRegistry,
): RegistryRecoveryCoordinator {
  const capability = coordinators.get(registry)
  if (capability === undefined) throw new TypeError('Registered recovery coordinator required')
  return capability
}
export function bindRegistryRecoveryCoordinator<TTx extends GroupTransaction>(params: {
  registry: GroupHandleRegistry
  entry: EntryCapability<TTx>
  persistence: GroupPersistence<TTx>
}): void {
  const { entry, persistence } = params
  coordinators.set(params.registry, {
    readRecoveryRecord: (key) =>
      entry.read(key.groupID, async (reads) =>
        copyStoredValue((await reads.control(key.incarnation)).rejoin),
      ),
    async assignSwitchID(record) {
      const mutationID = crypto.randomUUID()
      const switchMutationID = crypto.randomUUID()
      await entry.run(
        { groupID: record.source.key.groupID, mutationID },
        async (reads) => {
          if (
            record.stage !== 'confirmed' ||
            record.trigger !== 'automatic' ||
            record.authorisationID !== null ||
            record.switchMutationID !== null ||
            !sameStoredValue((await reads.control(record.source.key.incarnation)).rejoin, record)
          )
            throw new GroupStateConflictError(
              'Confirmed recovery moved before switch ID assignment',
            )
          const control = await reads.control(record.source.key.incarnation)
          if (controlSafetyHeld(control) !== null || control.controlHold !== null)
            throw new GroupStateConflictError('Recovery source is held')
          return { expected: await reads.lifetime(), value: null }
        },
        async (stores) => {
          const control = stores.incarnation(record.source.key.incarnation).control
          const snapshot = await control.load()
          if (controlSafetyHeld(snapshot) !== null || snapshot.controlHold !== null)
            throw new GroupStateConflictError('Recovery source is held')
          if (!sameStoredValue(snapshot.rejoin, record))
            throw new GroupStateConflictError(
              'Confirmed recovery moved before switch ID assignment',
            )
          await control.apply({ putRejoin: { ...record, switchMutationID } }, mutationID)
        },
      )
    },
    async resolveRecoverySwitch(record) {
      if (record.switchMutationID === null) return { kind: 'pending' }
      const key = record.source.key
      let proof: 'committed' | 'rolled-back' | undefined
      try {
        proof = await persistence.resolve(key.groupID, record.switchMutationID)
      } catch (error) {
        if (!(error instanceof GroupStateUncertainError)) throw error
      }
      // Read crosses the completion fence even when a later marker hid the saved ID.
      return await entry.read(key.groupID, async (reads) => {
        const saved = (await reads.control(key.incarnation)).rejoin
        const destination = { groupID: key.groupID, incarnation: key.incarnation + 1 }
        const metadata = await reads.metadata(destination.incarnation)
        const initial = metadata?.initialIdentity ?? null
        const trust =
          saved?.stage === 'confirmed' ? await readRetainedTrust(reads, key) : await reads.trust()
        const snapshot = decodeCapturedRecoveryCandidate(record.candidate, record.requestKey)
        const authenticator = snapshot.state.keySchedule.epochAuthenticator
        const spent =
          trust?.spentEpochAuthenticators.some((value) => sameStoredValue(value, authenticator)) ??
          false
        const installed = sameStoredValue(initial, {
          ...destination,
          epoch: record.epochAfter,
          authenticator,
        })
        if (
          saved !== null &&
          'format' in saved &&
          sameStoredValue(saved, { ...record, stage: 'adopted', destinationKey: destination }) &&
          installed &&
          spent
        )
          return { kind: 'committed', destination }
        if (
          proof !== 'committed' &&
          record.stage === 'confirmed' &&
          sameStoredValue(saved, record) &&
          metadata === null &&
          initial === null &&
          trust !== null &&
          !spent
        )
          return { kind: 'rolled-back' }
        return { kind: 'pending' }
      })
    },
  })
}
