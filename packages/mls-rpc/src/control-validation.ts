import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  CommitRejectedError,
  CommitValidationUnavailableError,
  commitValidationReason,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  type GroupOptions,
  isConclusiveCommitError,
  isTransientVerificationError,
  LeafBindingError,
  ledgerEntryDigest,
  MissingLedgerEntriesError,
  ownCommitDigest,
  readCommitEntryIDs,
  readMessageEpoch,
  restoreGroup,
  restrictCommitAuthoring,
  verifyLedgerEntry,
} from '@kumiai/mls'
import {
  type BuiltCommit,
  type CommitHeader,
  type ControlFrameValidation,
  type ControlValidationPort,
  createLedgerEntryResolver,
  decodeCommitFrame,
  decodeHandshakeFrame,
  decodeLedgerEntries,
  digestAppliedCommit,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
  isUnsupportedCommitFrameVersion,
  LedgerEntryRefusedError,
  type RecoveryCommitValidation,
  UnsupportedLedgerEntriesVersionError,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { CodecError } from 'ts-mls'

import { decodeControlJournal } from './control-journal.js'
import { deriveEntryKey, openEntries } from './crypto.js'
import { createLedgerEntrySlot } from './mls.js'
import { decodeStoredValue, encodeStoredValue } from './persistence-codec.js'

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function diagnostic(error: unknown): Exclude<ControlFrameValidation, { kind: 'valid' }> {
  let current = error
  let policyRefused = false
  const seen = new Set<unknown>()
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current)
    if (isTransientVerificationError(current))
      return { kind: 'unavailable', reason: 'unrecognised' }
    if (current instanceof CommitValidationUnavailableError)
      return { kind: 'unavailable', reason: current.reason }
    if (current instanceof LeafBindingError)
      return isConclusiveCommitError(current)
        ? { kind: 'invalid', reason: 'policy' }
        : { kind: 'unavailable', reason: 'unrecognised' }
    const dependencyReason = commitValidationReason(current)
    if (dependencyReason === 'missing-proposal' || dependencyReason === 'missing-key')
      return { kind: 'unavailable', reason: dependencyReason }
    if (dependencyReason === 'policy') return { kind: 'invalid', reason: 'policy' }
    if (current instanceof CodecError) return { kind: 'invalid', reason: 'malformed' }
    if (current instanceof LedgerEntryRefusedError)
      return { kind: 'invalid', reason: current.reason }
    if (isConclusiveCommitError(current)) return { kind: 'invalid', reason: 'authentication' }
    if (
      isUnsupportedCommitFrameVersion(current) ||
      current instanceof UnsupportedLedgerEntriesVersionError
    )
      return { kind: 'unavailable', reason: 'unsupported-version' }
    if (current instanceof MissingLedgerEntriesError)
      return { kind: 'unavailable', reason: 'resolver' }
    if (
      current instanceof CommitRejectedError &&
      !(current.cause instanceof CommitValidationUnavailableError)
    )
      policyRefused = true
    current = current.cause
  }
  return policyRefused
    ? { kind: 'invalid', reason: 'policy' }
    : { kind: 'unavailable', reason: 'unrecognised' }
}

export async function validateRecoveryCommit(
  group: GroupHandle,
  commit: Uint8Array,
  ownDID: string,
): Promise<RecoveryCommitValidation> {
  const epoch = Number(group.epoch)
  try {
    if (readMessageEpoch(commit) !== group.epoch) return { epoch }
    const header = await group.readCommitHeader(commit)
    if (
      header?.external !== true ||
      header.epoch !== group.epoch ||
      header.committerDID === undefined
    )
      return { epoch }
    const state = decodeClientState(encodeClientState(group.state))
    if (state === undefined) return { epoch }
    const working = restrictCommitAuthoring(
      new GroupHandle({
        state,
        credential: decodeStoredValue(
          encodeStoredValue(group.credential),
        ) as typeof group.credential,
        context: { ...group.context },
        ledger: decodeStoredValue(encodeStoredValue(group.ledger)) as typeof group.ledger,
      }),
    )
    if (normalizeDID(header.committerDID) === normalizeDID(ownDID))
      return { epoch, refusal: 'policy', refusalAuthority: 'authenticated-commit' }
    let policyFault = false
    try {
      const policy = group.commitPolicy
      await working.processMessage(
        commit,
        policy === undefined
          ? undefined
          : {
              commitPolicy: (incoming) => {
                try {
                  return policy(incoming)
                } catch (error) {
                  policyFault = true
                  throw error
                }
              },
            },
      )
      return { epoch, valid: true }
    } catch (error) {
      if (policyFault) return { epoch }
      const result = diagnostic(error)
      if (result.kind === 'invalid' && result.reason === 'policy')
        return {
          epoch,
          refusal: error instanceof CommitRejectedError ? error.reason : 'policy',
          refusalAuthority: 'authenticated-commit',
        }
    }
  } catch {
    // Authentication, framing and local validation faults supply no refusal authority.
  }
  return { epoch }
}

export function createControlValidationPort(params: {
  identity: OwnIdentity
  options: GroupOptions
  entryLabel?: string
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlValidationPort {
  return {
    async restoreValidation(built) {
      let journal: ReturnType<typeof decodeControlJournal>
      try {
        journal = decodeControlJournal(built.journal.slice())
      } catch {
        return null
      }
      const identity = journal.source.identity
      if (
        identity === null ||
        journal.checkpoint !== built.searchFrom ||
        identity.epoch !== built.epoch ||
        identity.incarnation !== built.incarnation ||
        !sameBytes(identity.authenticator, built.authenticatorBefore) ||
        toB64U(sha256(built.payload)) !== built.payloadDigest
      )
        return null
      const {
        onLedgerEntries: _notify,
        resolveLedgerEntries: _resolve,
        ...options
      } = params.options
      const restore = async () => {
        const slot = createLedgerEntrySlot()
        const state = decodeClientState(journal.sourceState.slice())
        if (state === undefined)
          throw new CommitValidationUnavailableError('Retained source unavailable', {
            reason: 'missing-key',
          })
        const credential = decodeStoredValue(
          encodeStoredValue(journal.sourceCredential),
        ) as typeof journal.sourceCredential
        return {
          slot,
          group: restrictCommitAuthoring(
            await restoreGroup({
              state,
              credential,
              ledgerEntries: [...journal.sourceLedger],
              options: { ...options, resolveLedgerEntries: slot.resolve },
            }),
          ),
        }
      }
      type Restored = Awaited<ReturnType<typeof restore>>
      type MLSHeader = Awaited<ReturnType<GroupHandle['readCommitHeader']>>
      const reads = new WeakMap<
        CommitHeader,
        { restored: Restored; header: MLSHeader; commit: Uint8Array }
      >()
      let ownVerification: Promise<boolean> | undefined
      const verifyOwn = async (
        value: BuiltCommit,
        restored?: Restored,
        readHeader?: MLSHeader,
      ): Promise<boolean> => {
        if (
          value.searchFrom !== journal.checkpoint ||
          value.epoch !== identity.epoch ||
          value.incarnation !== identity.incarnation ||
          !sameBytes(value.authenticatorBefore, identity.authenticator) ||
          !sameBytes(value.payload, built.payload) ||
          !sameBytes(value.journal, built.journal) ||
          value.payloadDigest !== built.payloadDigest ||
          toB64U(sha256(value.payload)) !== value.payloadDigest ||
          value.digest !== built.digest
        )
          return false
        ownVerification ??= (async () => {
          const { group: source } = restored ?? (await restore())
          try {
            const handshake = decodeHandshakeFrame(value.payload)
            if (handshake.version !== HANDSHAKE_VERSION || handshake.kind !== HANDSHAKE_KIND.commit)
              return false
            const commit = decodeCommitFrame(handshake.payload).commit
            if (digestAppliedCommit(commit) !== value.digest) return false
            const header = readHeader ?? (await source.readCommitHeader(commit))
            if (
              header?.epoch !== BigInt(identity.epoch) ||
              header.external === true ||
              header.committerDID === undefined ||
              normalizeDID(header.committerDID) !== normalizeDID(params.identity.id) ||
              normalizeDID(journal.sourceCredential.id) !== normalizeDID(params.identity.id) ||
              !(await source.verifyCommitSignature(commit))
            )
              return false
          } catch {
            return false
          }
          const candidate = restrictCommitAuthoring(
            await params.restoreCandidate(journal.candidate.slice()),
          )
          const history = candidate.state.historicalReceiverData.get(BigInt(identity.epoch))
          return (
            (journal.candidateAuthenticator === undefined ||
              sameBytes(
                candidate.state.keySchedule.epochAuthenticator,
                journal.candidateAuthenticator,
              )) &&
            candidate.groupID === identity.groupID &&
            candidate.epoch === BigInt(identity.epoch + 1) &&
            normalizeDID(candidate.credential.id) === normalizeDID(params.identity.id) &&
            history !== undefined &&
            sameBytes(history.resumptionPsk, source.state.keySchedule.resumptionPsk) &&
            sameBytes(history.senderDataSecret, source.state.keySchedule.senderDataSecret) &&
            sameBytes(
              encodeClientState({
                ...source.state,
                groupContext: history.groupContext,
                ratchetTree: history.ratchetTree,
              }),
              encodeClientState(source.state),
            )
          )
        })()
        return ownVerification
      }
      return {
        source: journal.source,
        async readCommitHeader(commit) {
          const restored = await restore()
          const header = await restored.group.readCommitHeader(commit.slice())
          if (header === null) return null
          const converted = { ...header, epoch: Number(header.epoch) }
          reads.set(converted, { restored, header, commit: commit.slice() })
          return converted
        },
        verifyOwn,
        async validateFrame(frame, value, readHeader) {
          let commit: Uint8Array
          let sealedEntries: Uint8Array
          try {
            const handshake = decodeHandshakeFrame(frame.payload.slice())
            if (handshake.version !== HANDSHAKE_VERSION)
              return { kind: 'unavailable', reason: 'unsupported-version' }
            if (handshake.kind !== HANDSHAKE_KIND.commit)
              return { kind: 'invalid', reason: 'non-commit' }
            const decoded = decodeCommitFrame(handshake.payload)
            commit = decoded.commit
            sealedEntries = decoded.sealedEntries
          } catch (error) {
            return isUnsupportedCommitFrameVersion(error)
              ? { kind: 'unavailable', reason: 'unsupported-version' }
              : { kind: 'invalid', reason: 'malformed' }
          }
          const read = readHeader == null ? undefined : reads.get(readHeader)
          const retainedRead =
            read !== undefined && sameBytes(read.commit, commit) ? read : undefined
          if (readHeader != null) reads.delete(readHeader)
          const restored = retainedRead?.restored ?? (await restore())
          const { group: working, slot } = restored
          let header: Awaited<ReturnType<GroupHandle['readCommitHeader']>>
          try {
            header = retainedRead?.header ?? (await working.readCommitHeader(commit))
          } catch (error) {
            return diagnostic(error)
          }
          if (header === null) return { kind: 'invalid', reason: 'non-commit' }
          if (header.epoch !== BigInt(identity.epoch))
            return { kind: 'invalid', reason: 'malformed' }
          if (header.committerDID === undefined)
            return { kind: 'invalid', reason: 'authentication' }
          // External replacement of the retained local identity needs new private keys. It is
          // deterministic policy refusal here, and says nothing about own member authorship.
          if (
            header.external === true &&
            normalizeDID(header.committerDID) === normalizeDID(params.identity.id)
          )
            return { kind: 'invalid', reason: 'policy' }
          const claimsOwn =
            header.external !== true &&
            normalizeDID(header.committerDID) === normalizeDID(params.identity.id)
          if (claimsOwn) {
            const savedCommit = decodeCommitFrame(
              decodeHandshakeFrame(value.payload).payload,
            ).commit
            const savedRecognition = ownCommitDigest(savedCommit)
            const deliveredRecognition = ownCommitDigest(commit)
            if (
              savedRecognition === null ||
              deliveredRecognition === null ||
              savedRecognition !== deliveredRecognition
            ) {
              try {
                if (!(await working.verifyCommitSignature(commit)))
                  return { kind: 'invalid', reason: 'authentication' }
              } catch (error) {
                return diagnostic(error)
              }
              return { kind: 'unavailable', reason: 'unexplained-own' }
            }
            if (!(await verifyOwn(value, restored, header)))
              return { kind: 'unavailable', reason: 'unexplained-own' }
            // Own receive keys cannot apply the saved commit. Its candidate proves MLS validation;
            // resolve only references absent from the same retained pre-state as a receiver.
            const held = new Set(journal.sourceLedger.map(ledgerEntryDigest))
            const missing = readCommitEntryIDs(commit).filter((id) => !held.has(id))
            const key =
              missing.length === 0 ? null : await deriveEntryKey(working, params.entryLabel)
            try {
              const resolve = createLedgerEntryResolver(sealedEntries, async (blob) => {
                if (key === null) throw new Error('Unexpected no-entry resolution')
                return openEntries(key, blob)
              })
              const resolved = new Set<string>()
              for (const token of await resolve(missing)) {
                const id = ledgerEntryDigest(token)
                if (
                  missing.includes(id) &&
                  !resolved.has(id) &&
                  (await verifyLedgerEntry(token)) !== null
                )
                  resolved.add(id)
              }
              if (missing.some((id) => !resolved.has(id)))
                return { kind: 'unavailable', reason: 'unexplained-own' }
            } catch {
              return { kind: 'unavailable', reason: 'unexplained-own' }
            } finally {
              key?.fill(0)
            }
            return {
              kind: 'valid',
              header: { ...header, epoch: Number(header.epoch) },
              own: true,
              advanced: true,
              removed: false,
            }
          }
          let resolverError: unknown
          let localFailure: { error: unknown } | undefined
          slot.install(async () => {
            let key: Uint8Array
            try {
              key = await deriveEntryKey(working, params.entryLabel)
            } catch (error) {
              localFailure = { error }
              throw error
            }
            try {
              const opened = openEntries(key, sealedEntries.slice())
              try {
                return decodeLedgerEntries(opened)
              } catch (error) {
                if (error instanceof UnsupportedLedgerEntriesVersionError) throw error
                throw new LedgerEntryRefusedError('Malformed ledger entries', {
                  cause: error,
                  reason: 'malformed',
                })
              }
            } catch (error) {
              resolverError = error
              throw error
            } finally {
              key.fill(0)
            }
          })
          try {
            const before = working.epoch
            const policy = params.options.commitPolicy
            await working.processMessage(
              commit,
              policy === undefined
                ? undefined
                : {
                    commitPolicy: (incoming) => {
                      try {
                        return policy(incoming)
                      } catch (error) {
                        localFailure = { error }
                        throw error
                      }
                    },
                  },
            )
            return {
              kind: 'valid',
              header: { ...header, epoch: Number(header.epoch) },
              own: false,
              advanced: working.epoch !== before,
              removed: working.state.groupActiveState.kind === 'removedFromGroup',
            }
          } catch (error) {
            if (localFailure !== undefined) throw localFailure.error
            if (resolverError !== undefined) {
              const result = diagnostic(resolverError)
              return result.kind === 'unavailable' && result.reason === 'unrecognised'
                ? { kind: 'unavailable', reason: 'resolver' }
                : result
            }
            return diagnostic(error)
          } finally {
            slot.install(undefined)
          }
        },
      }
    },
  }
}
