import { normalizeDID, type OwnIdentity } from '@kokuin/token'
import {
  CommitRejectedError,
  CommitValidationUnavailableError,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  type GroupOptions,
  isConclusiveCommitError,
  MissingLedgerEntriesError,
  restoreGroup,
} from '@kumiai/mls'
import {
  type BuiltCommit,
  type ControlFrameValidation,
  type ControlValidationPort,
  decodeCommitFrame,
  decodeHandshakeFrame,
  decodeLedgerEntries,
  digestAppliedCommit,
  HANDSHAKE_KIND,
  HANDSHAKE_VERSION,
  isUnsupportedCommitFrameVersion,
  LedgerEntryRefusedError,
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
    if (current.message === 'Could not find proposal with supplied reference')
      return { kind: 'unavailable', reason: 'missing-proposal' }
    if (
      current.message === 'Desired generation too far in the future' ||
      current.message === 'Desired gen in the past' ||
      current.message.includes('sender key unavailable')
    )
      return { kind: 'unavailable', reason: 'missing-key' }
    if (current instanceof CodecError) return { kind: 'invalid', reason: 'malformed' }
    if (isConclusiveCommitError(current) || current instanceof LedgerEntryRefusedError)
      return { kind: 'invalid', reason: 'authentication' }
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
          throw new CommitValidationUnavailableError('Retained source unavailable')
        const credential = decodeStoredValue(
          encodeStoredValue(journal.sourceCredential),
        ) as typeof journal.sourceCredential
        return {
          slot,
          group: await restoreGroup({
            state,
            credential,
            ledgerEntries: [...journal.sourceLedger],
            options: { ...options, resolveLedgerEntries: slot.resolve },
          }),
        }
      }
      const verifyOwn = async (value: BuiltCommit): Promise<boolean> => {
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
        try {
          const handshake = decodeHandshakeFrame(value.payload)
          if (handshake.version !== HANDSHAKE_VERSION || handshake.kind !== HANDSHAKE_KIND.commit)
            return false
          const commit = decodeCommitFrame(handshake.payload).commit
          if (digestAppliedCommit(commit) !== value.digest) return false
          const { group: source } = await restore()
          const header = await source.readCommitHeader(commit)
          if (
            header?.epoch !== BigInt(identity.epoch) ||
            header.committerDID === undefined ||
            normalizeDID(header.committerDID) !== normalizeDID(params.identity.id) ||
            normalizeDID(journal.sourceCredential.id) !== normalizeDID(params.identity.id)
          )
            return false
          const candidate = await params.restoreCandidate(journal.candidate.slice())
          const history = candidate.state.historicalReceiverData.get(BigInt(identity.epoch))
          return (
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
        } catch {
          return false
        }
      }
      return {
        source: journal.source,
        async readCommitHeader(commit) {
          const { group } = await restore()
          const header = await group.readCommitHeader(commit.slice())
          return header === null ? null : { ...header, epoch: Number(header.epoch) }
        },
        verifyOwn,
        async validateFrame(frame, value) {
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
          let restored: Awaited<ReturnType<typeof restore>>
          try {
            restored = await restore()
          } catch (error) {
            return diagnostic(error)
          }
          const { group: working, slot } = restored
          let header: Awaited<ReturnType<GroupHandle['readCommitHeader']>>
          try {
            header = await working.readCommitHeader(commit)
          } catch (error) {
            return diagnostic(error)
          }
          if (header === null) return { kind: 'invalid', reason: 'non-commit' }
          if (header.epoch !== BigInt(identity.epoch))
            return { kind: 'unavailable', reason: 'missing-key' }
          if (header.committerDID === undefined)
            return { kind: 'invalid', reason: 'authentication' }
          const own = normalizeDID(header.committerDID) === normalizeDID(params.identity.id)
          if (own) {
            if (!sameBytes(frame.payload, value.payload))
              return { kind: 'unavailable', reason: 'unexplained-own' }
            return (await verifyOwn(value))
              ? {
                  kind: 'valid',
                  header: { ...header, epoch: Number(header.epoch) },
                  own: true,
                  advanced: true,
                  removed: false,
                }
              : { kind: 'unavailable', reason: 'unexplained-own' }
          }
          let resolverError: unknown
          slot.install(async () => {
            let key: Uint8Array
            try {
              key = await deriveEntryKey(working, params.entryLabel)
            } catch (error) {
              resolverError = error
              throw error
            }
            try {
              const opened = openEntries(key, sealedEntries.slice())
              try {
                return decodeLedgerEntries(opened)
              } catch (error) {
                if (error instanceof UnsupportedLedgerEntriesVersionError) throw error
                throw new LedgerEntryRefusedError('Malformed ledger entries', { cause: error })
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
            await working.processMessage(commit)
            return {
              kind: 'valid',
              header: { ...header, epoch: Number(header.epoch) },
              own: false,
              advanced: working.epoch !== before,
              removed: working.state.groupActiveState.kind === 'removedFromGroup',
            }
          } catch (error) {
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
