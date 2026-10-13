import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import { judgeWelcomeAdmission } from '@kumiai/mls-hub'

import type { EntryCapability, EntryReads, StateMetadata } from '../entry-capability.js'
import { sameStoredValue } from '../memory-incarnation-stores.js'
import { isStoredOpenFailure } from '../persistence-codec.js'
import { GroupStateConflictError, SeedAdmissionRefusedError } from '../persistence-errors.js'
import { assertTrustTransition } from '../persistence-guards.js'
import type {
  GroupKey,
  GroupLifetime,
  GroupRecoveryTrust,
  GroupTransaction,
  PackageUse,
} from '../persistence-types.js'
import { retireIncarnation } from './retired.js'
import type { RegistryRetirement } from './retirement.js'
import { recoveryTrustFor } from './trust.js'
import type { RetirementAttempt } from './types.js'
import { type RecoveryEnvironment, validateRegistryHandle } from './validation.js'

type AdmissionInputs = {
  lifetime: GroupLifetime | null
  metadata: StateMetadata | null
  trust: GroupRecoveryTrust | null
}
type SeedDecision = 'join' | 'alreadyJoined' | 'readmit' | 'next-incarnation'

export function seedAdmission(
  params: AdmissionInputs & {
    welcome: { epoch: number; epochAuthenticator: Uint8Array }
    replace?: boolean
    forkHalted: boolean
  },
): SeedDecision {
  const { lifetime, metadata, trust, welcome, replace, forkHalted } = params
  if (lifetime === null) {
    if (metadata !== null || trust !== null)
      throw new SeedAdmissionRefusedError({ reason: 'unavailable' })
  } else {
    if (lifetime.restorePending || trust === null)
      throw new SeedAdmissionRefusedError({ reason: 'unavailable' })
    try {
      assertTrustTransition(null, trust)
      if (
        trust.groupID !== lifetime.groupID ||
        trust.spentEpochAuthenticators.length === 0 ||
        !Number.isSafeInteger(lifetime.latestIncarnation) ||
        lifetime.latestIncarnation < 1 ||
        !Number.isSafeInteger(lifetime.revision) ||
        lifetime.revision < 1 ||
        (lifetime.activeIncarnation !== null &&
          lifetime.activeIncarnation !== lifetime.latestIncarnation)
      ) {
        throw new GroupStateConflictError('Invalid surviving admission trust or lifetime')
      }
    } catch (cause) {
      // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause.
      throw new SeedAdmissionRefusedError({ reason: 'unavailable', cause })
    }
  }
  const spent = trust?.spentEpochAuthenticators ?? []
  if (spent.some((value) => sameStoredValue(value, welcome.epochAuthenticator)))
    throw new SeedAdmissionRefusedError({ reason: 'spent' })
  if (forkHalted) throw new SeedAdmissionRefusedError({ reason: 'fork-halted' })
  const active = lifetime?.activeIncarnation ?? null
  if (
    active !== null &&
    (metadata === null ||
      metadata.groupID !== lifetime?.groupID ||
      metadata.incarnation !== active ||
      metadata.deleted !== false ||
      !Number.isSafeInteger(metadata.version) ||
      metadata.version < 1 ||
      trust?.installed.groupID !== lifetime?.groupID ||
      trust?.installed.incarnation !== active)
  )
    throw new SeedAdmissionRefusedError({ reason: 'invalid-active-metadata' })
  const decision = judgeWelcomeAdmission({
    held:
      lifetime === null
        ? null
        : {
            incarnation: lifetime.latestIncarnation,
            epoch: active === null ? null : (trust?.installed.epoch ?? null),
            deleted: active === null,
            forkHalted,
          },
    spentEpochAuthenticators: spent,
    welcome,
  })
  if (decision === 'refused') throw new SeedAdmissionRefusedError({ reason: 'unavailable' })
  if (decision === 'replace') {
    if (replace !== true) throw new SeedAdmissionRefusedError({ reason: 'replace-required' })
    return 'readmit'
  }
  if (decision === 'join') return lifetime === null ? 'join' : 'next-incarnation'
  return 'alreadyJoined'
}

function metadataFailure(cause: unknown): never {
  if (cause instanceof GroupStateConflictError || isStoredOpenFailure(cause))
    throw new SeedAdmissionRefusedError({ reason: 'invalid-active-metadata', cause })
  throw cause
}
async function readAdmission(
  reads: Pick<EntryReads, 'lifetime' | 'trust' | 'metadata'>,
): Promise<AdmissionInputs> {
  let lifetime: GroupLifetime | null
  let trust: GroupRecoveryTrust | null
  try {
    lifetime = await reads.lifetime()
    trust = await reads.trust()
  } catch (cause) {
    if (!(cause instanceof GroupStateConflictError) && !isStoredOpenFailure(cause)) throw cause
    // biome-ignore lint/style/useErrorCause: The constructor forwards params.cause.
    throw new SeedAdmissionRefusedError({ reason: 'unavailable', cause })
  }
  let metadata: StateMetadata | null = null
  if (lifetime?.activeIncarnation != null) {
    try {
      metadata = await reads.metadata(lifetime.activeIncarnation)
    } catch (cause) {
      metadataFailure(cause)
    }
  }
  return { lifetime, trust, metadata }
}

export function createRegistrySeed<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>
  retirement: RegistryRetirement
  environment: RecoveryEnvironment
  ownerDID: string
  start(): Promise<void>
}) {
  return async (
    group: GroupHandle,
    options: { replace?: boolean; packageUse: PackageUse | null },
  ): Promise<GroupKey> => {
    const groupID = group.groupID
    params.retirement.assertAvailable(groupID)
    await params.start()
    const welcome = {
      epoch: Number(group.epoch),
      epochAuthenticator: group.state.keySchedule.epochAuthenticator.slice(),
    }
    const replace = options.replace
    const packageUse = options.packageUse === null ? null : { ...options.packageUse }
    if (welcome.epoch === 0) {
      if (packageUse !== null) throw new SeedAdmissionRefusedError({ reason: 'invalid-genesis' })
    } else if (
      packageUse === null ||
      typeof packageUse.sourceID !== 'string' ||
      packageUse.sourceID.length === 0 ||
      typeof packageUse.ref !== 'string' ||
      packageUse.ref.length === 0 ||
      (packageUse.kind !== 'ordinary' && packageUse.kind !== 'last-resort')
    ) {
      throw new SeedAdmissionRefusedError({ reason: 'invalid-package-use' })
    }
    const admission = await params.capability.read(groupID, readAdmission)
    function judge(inputs: AdmissionInputs): SeedDecision {
      if (welcome.epoch === 0 && inputs.lifetime !== null)
        throw new SeedAdmissionRefusedError({ reason: 'invalid-genesis' })
      return seedAdmission({ ...inputs, welcome, replace, forkHalted: false })
    }
    const decision = judge(admission)
    const activeIncarnation = admission.lifetime?.activeIncarnation ?? null
    const source = activeIncarnation === null ? null : { groupID, incarnation: activeIncarnation }
    if (decision === 'alreadyJoined' && source === null)
      throw new SeedAdmissionRefusedError({ reason: 'invalid-active-metadata' })
    const key = {
      groupID,
      incarnation:
        decision === 'alreadyJoined' && source !== null
          ? source.incarnation
          : (admission.lifetime?.latestIncarnation ?? 0) + 1,
    }
    validateRegistryHandle({
      handle: group,
      key,
      trust: admission.trust,
      environment: params.environment,
      ownerDID: params.ownerDID,
    })
    if (decision === 'alreadyJoined') return key
    const mutationID = crypto.randomUUID()
    let attempt: RetirementAttempt | null = null
    try {
      if (decision === 'readmit' && source !== null) {
        attempt = params.retirement.beginRetirement(source)
        await attempt.drain()
      }
      function recheck(inputs: AdmissionInputs): void {
        const current = judge(inputs)
        if (current !== decision || !sameStoredValue(inputs, admission))
          throw new GroupStateConflictError('Seed admission moved')
      }
      const result = await params.capability.run(
        { groupID, mutationID },
        async (reads) => {
          const current = await readAdmission(reads)
          recheck(current)
          validateRegistryHandle({
            handle: group,
            key,
            trust: current.trust,
            environment: params.environment,
            ownerDID: params.ownerDID,
          })
          return {
            expected: current.lifetime,
            value: {
              // Staged for the later combined package-install boundary; no provider package hook here.
              packageUse,
              state: encodeClientState(group.state),
              credential: { ...group.credential },
              ledger: [...group.ledgerTokens],
              trust: recoveryTrustFor(group, key, current.trust),
            },
          }
        },
        async (stores, prepared) => {
          const current = await readAdmission({
            lifetime: stores.lifetime.load,
            trust: stores.trust.load,
            metadata: (incarnation) => stores.incarnation(incarnation).state.loadMetadata(),
          })
          recheck(current)
          if (decision === 'readmit' && source !== null)
            await retireIncarnation(stores, {
              source,
              nextIncarnation: key.incarnation,
              mutationID,
              at: Date.now(),
            })
          await stores.lifetime.save({
            groupID,
            latestIncarnation: key.incarnation,
            activeIncarnation: key.incarnation,
            revision: (current.lifetime?.revision ?? 0) + 1,
            mutationID,
            restorePending: false,
          })
          const rows = stores.incarnation(key.incarnation)
          await rows.state.save({
            ...key,
            version: 1,
            deleted: false,
            terminal: false,
            epoch: welcome.epoch,
            epochAuthenticator: welcome.epochAuthenticator,
            state: prepared.state,
            credential: prepared.credential,
            ledger: prepared.ledger,
            senderHWM: 0,
          })
          await stores.trust.save(prepared.trust)
          await rows.control.apply({ cursor: null }, mutationID)
          await rows.anchor.save(null)
          return key
        },
      )
      attempt?.settle('committed')
      return result
    } catch (error) {
      attempt?.settle('rolled-back')
      throw error
    }
  }
}
