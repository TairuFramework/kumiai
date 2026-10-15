import {
  isVerifiedToken,
  normalizeDID,
  type OwnIdentity,
  stringifyToken,
  verifyToken,
} from '@kokuin/token'
import {
  CommitValidationUnavailableError,
  confirmationKey,
  createRecoveryRequest,
  encodeGroupAnchor,
  type GroupHandle,
  ledgerEntryDigest,
  MissingLedgerEntriesError,
  openRecoveryGroupInfo,
  openRecoveryVerdict,
  openSealedLedger,
  ownCommitDigest,
  type RecoveryGroupInfo,
  readCommitEntryIDs,
  readMessageEpoch,
  recoverySignerEligible,
  restoreGroup,
  sealCapturedGroupInfo,
  sealGroupInfo,
  sealLedger,
  sealRecoveryVerdict,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import type {
  AdoptionExpected,
  AdoptionWriteFactory,
  AppliedRecovery,
  CommitContext,
  CommitHeader,
  ControlStore,
  GroupMLS,
  LogPosition,
  OpenedRecoveryVerdict,
  ProcessCommitResult,
  RecoveryConfirmationBinding,
  RecoveryRefusalReason,
  RecoveryVerdict,
  ResyncProof,
  RosterEntry,
  SafetyHold,
} from '@kumiai/rpc'
import { ControlWriteNotCommittedError } from '@kumiai/rpc'
import { ciphersuites } from 'ts-mls'

import type { ControlHandleAccess } from './access.js'
import { applyCommit } from './apply-commit.js'
import { validateRecoveryCommit } from './control-validation.js'
import type { GroupRecoveryTrust } from './persistence-types.js'
import {
  type BoundRecoveryCommit,
  createRecoveryBindingState,
  createRecoveryRequestFromTrust,
  createVerdictJudge,
  deriveRecoverySecretFromTrust,
  knownRecoveryRegistry,
  openRecoveryVerdictFromTrust,
  RECOVERY_LABEL,
  type RecoveryBinding,
  type RecoveryCandidate,
} from './recovery.js'
import { decodeRecoveryCandidate, encodeRecoveryCandidate } from './recovery-codec.js'
import type { RegistryRecoverySource } from './registry/types.js'
import type { RecoveryEnvironment } from './registry/validation.js'

export const groupHandleAccess = new WeakMap<GroupMLS, ControlHandleAccess>()

const recoveryAcceptances = new WeakMap<ControlHandleAccess, Map<string, Promise<void>>>()

const utf8 = new TextEncoder()

/**
 * The label the non-rotating recovery secret is derived under. This secret is the root of
 * BOTH the commit topic and the rendezvous topic — everything downstream of it depends on
 * this one label.
 *
 * **This secret is NOT epoch-bound and must never be used for anything that a removed
 * member has to be cut off from.** The port asks for exactly that — a value stable for the
 * group's whole life, so a peer stranded at any epoch can still name the topic it heals on —
 * and a removed member keeps it for life by design.
 */
export { RECOVERY_LABEL } from './recovery.js'

/**
 * A per-commit ledger-entry resolver, installed at handle-construction time and swapped
 * per commit.
 *
 * WHY THIS EXISTS, and it is a seam rather than a nicety: {@link GroupMLS.processCommit}
 * is handed a `resolveLedgerEntries` scoped to ONE commit's frame — the bodies ride that
 * frame and nowhere else — but `@kumiai/mls`'s `GroupHandle` takes its resolver once, in
 * `GroupOptions`, and offers no way to change it afterwards. So a host cannot honour the
 * per-commit contract with a plain handle: it must install this indirection when it BUILDS
 * the group (createGroup / processWelcome / restoreGroup) and hand the same slot to the
 * ports. Passing anything else means a commit resolves entries against whatever resolver
 * the handle happened to be born with.
 */
export type LedgerEntrySlot = {
  /** Pass as `GroupOptions.resolveLedgerEntries` wherever the handle is built. */
  resolve: (ids: Array<string>) => Promise<Array<string>>
  /** Install the resolver riding one commit's frame, for that commit's duration. */
  install: (resolver: ((ids: Array<string>) => Promise<Array<string>>) | undefined) => void
}

export function createLedgerEntrySlot(): LedgerEntrySlot {
  let current: ((ids: Array<string>) => Promise<Array<string>>) | undefined
  return {
    resolve: async (ids) => {
      if (current == null) {
        // No frame is being applied, or the frame carried no resolver. The handle's
        // pre-pass reads this as "the bodies are not reachable", which is the truth.
        throw new MissingLedgerEntriesError(ids)
      }
      return await current(ids)
    },
    install: (resolver) => {
      current = resolver
    },
  }
}

export type RecoveryRouting = { targetID: string; topicID: string }

export type RecoveryAdoptionDependencies = {
  target: RecoveryRouting
  environment: RecoveryEnvironment
  readRecoverySource(): Promise<RegistryRecoverySource>
  accept(
    candidate: GroupHandle,
    params: {
      source: RegistryRecoverySource
      proof: ResyncProof
      write: AdoptionWriteFactory
    },
  ): Promise<void>
}

export type GroupMLSDependencies = {
  control: ControlStore
  readRecoverySource(): Promise<AdoptionExpected>
  recoveryAdoption?: RecoveryAdoptionDependencies
  onSafetyHold?: (latch: (reason: NonNullable<SafetyHold>) => void) => () => void
  recoverySecretFromTrust?: (trust: GroupRecoveryTrust) => Promise<Uint8Array>
}

export type GroupMLSParams = Partial<GroupMLSDependencies> & {
  access: ControlHandleAccess
  /** This member's signing identity: recovery requests and attestations are signed with it. */
  identity: OwnIdentity
  /** The slot the handle was built with. See {@link LedgerEntrySlot}. */
  entrySlot: LedgerEntrySlot
  /**
   * The group's recovery secret, read under `access.read`. Defaults to
   * {@link deriveRecoverySecret}. A host whose groups already use another derivation passes it
   * here for every restore of that group: the commit and rendezvous topics follow the choice.
   */
  recoverySecret?: (handle: GroupHandle) => Promise<Uint8Array>
  /**
   * Fresh own-leaf binding, at most once per `prepareRecovery()` round and its following reply
   * validation combined. Expiry then a floor refusal can cause two calls in the same attempt;
   * each binding/lapse/floor refusal starts another round under the original deadline.
   * No fixed call bound per attempt. Return null without waiting on the user.
   */
  recoveryBinding?: RecoveryBinding
}

/** Below this a topic secret is guessable; the default derives 32 bytes. */
const MIN_RECOVERY_SECRET_BYTES = 16

export async function deriveRecoverySecret(handle: GroupHandle): Promise<Uint8Array> {
  const { cipherSuite } = handle.context
  return await cipherSuite.kdf.expand(
    await cipherSuite.kdf.extract(utf8.encode(handle.groupID), encodeGroupAnchor(handle.anchor)),
    utf8.encode(RECOVERY_LABEL),
    32,
  )
}

/**
 * {@link GroupMLS} over a live {@link GroupHandle} — the real lifecycle port.
 *
 * ## Where this diverges from the memory double in `@kumiai/rpc`'s fixtures
 *
 * 1. **`processCommit` advances the handle IN PLACE for a received commit.** ts-mls's
 *    `processMessage` replaces the handle's own state, so there is nothing to adopt: the
 *    double models a commit as a value that is adopted separately, which is only true for a
 *    commit this member AUTHORED (those really do produce a fresh handle, and the peer
 *    adopts it in `onAccepted`). A host that treated every commit as adopt-later would
 *    double-apply received ones.
 *
 * 2. **`rosterEntries` reads the ratchet tree, so a leaf with an unparsable credential is
 *    simply absent** rather than present-with-a-placeholder. The double's roster is a set of
 *    strings it was handed.
 *
 * 3. **`exportRecoverySecret` is derived from the group's GENESIS ANCHOR, which is public.**
 *    MLS has no lifelong group secret — every key schedule secret rotates with the epoch, and
 *    a member who joined at epoch 5 never held epoch 0's — so there is nothing secret and
 *    epoch-independent to derive it from. The double returns an opaque secret handed to it,
 *    which reads as though the value were confidential. It is not: anyone who has seen a
 *    GroupInfo for this group can compute the rendezvous topic. That is tolerable for what the
 *    topic is for (a stranded peer must be able to name it, and so must a removed one) but a
 *    host must not put anything on it that confidentiality depends on.
 */
export function createGroupMLS(params: GroupMLSParams): GroupMLS {
  const { access, identity, entrySlot } = params
  const recovery = createRecoveryBindingState(identity, params.recoveryBinding)

  let acceptances = recoveryAcceptances.get(access)
  if (acceptances == null) {
    acceptances = new Map()
    recoveryAcceptances.set(access, acceptances)
  }
  const accepting = acceptances
  function makeCandidate(
    data: Omit<
      RecoveryCandidate,
      'markBindingUnusable' | 'confirmationKey' | 'judgeVerdict' | 'onAccepted' | 'serialize'
    >,
    requestID: string,
    requestKey: Uint8Array,
    boundCommit?: BoundRecoveryCommit,
  ): RecoveryCandidate {
    const judge = createVerdictJudge({
      group: data.group,
      sourceTree: data.sourceTree,
      known: data.knownRegistry,
      requestID,
      boundCommit,
    })
    const authenticator = data.group.state.keySchedule.epochAuthenticator
    const id = Array.from(authenticator).join(',')
    let accepted: Promise<void> | undefined
    return {
      ...data,
      markBindingUnusable: () => recovery.markCandidateBindingUnusable(data.group),
      confirmationKey: judge.confirmationKey,
      judgeVerdict: judge.judgeVerdict,
      serialize: () =>
        encodeRecoveryCandidate(
          { ...data, state: data.group.state, requestID, boundCommit: judge.boundCommit() },
          requestKey,
        ),
      onAccepted: (write: AdoptionWriteFactory) => {
        if (typeof write !== 'function') {
          return Promise.reject(
            new ControlWriteNotCommittedError('Recovery requires an adoption write factory'),
          )
        }
        if (accepted == null) {
          let adoption = accepting.get(id)
          if (adoption == null) {
            adoption = (async () => {
              // Restored adoption co-commits this authenticator and its control write before publication.
              if (
                await access.read((current) =>
                  sameBytes(current.state.keySchedule.epochAuthenticator, authenticator),
                )
              )
                return
              await access.replace(data.group, write)
            })()
            accepting.set(id, adoption)
            void adoption.then(
              () => accepting.delete(id),
              () => accepting.delete(id),
            )
          }
          accepted = adoption.catch((error: unknown) => {
            accepted = undefined
            throw error
          })
        }
        return accepted
      },
    }
  }

  const port: GroupMLS = {
    async signRecoveryConfirmation(binding: RecoveryConfirmationBinding) {
      const groupID =
        params.readRecoverySource === undefined
          ? await access.read((group) => group.groupID)
          : (await params.readRecoverySource()).key.groupID
      if (binding.groupID !== groupID) throw new Error('Confirmation group mismatch')
      return new TextEncoder().encode(
        stringifyToken(
          await identity.signToken(
            { ...binding, type: 'kumiai/recovery-confirmation/v1' },
            { embedLongForm: true },
          ),
        ),
      )
    },
    async verifyRecoveryConfirmation(binding, signature, requesterDID) {
      try {
        const token = await verifyToken<RecoveryConfirmationBinding & { type: string }>(
          new TextDecoder().decode(signature),
        )
        if (!isVerifiedToken(token)) return false
        const value = token.payload
        return (
          value.type === 'kumiai/recovery-confirmation/v1' &&
          normalizeDID(value.iss) === normalizeDID(requesterDID) &&
          value.groupID === binding.groupID &&
          value.requestID === binding.requestID &&
          value.position === binding.position &&
          value.commitDigest === binding.commitDigest &&
          value.groupID ===
            (params.readRecoverySource === undefined
              ? await access.read((group) => group.groupID)
              : (await params.readRecoverySource()).key.groupID)
        )
      } catch {
        return false
      }
    },
    async verifyRecoveryRequest(request: Uint8Array) {
      try {
        const verified = await verifyRecoveryRequest(new TextDecoder().decode(request))
        if (params.readRecoverySource !== undefined) {
          const source = await params.readRecoverySource()
          return verified.groupID === source.key.groupID
            ? {
                groupID: verified.groupID,
                requestID: verified.requestID,
                requesterDID: verified.requesterDID,
              }
            : null
        }
        return await access.read((group) =>
          verified.groupID === group.groupID
            ? {
                groupID: verified.groupID,
                requestID: verified.requestID,
                requesterDID: verified.requesterDID,
              }
            : null,
        )
      } catch {
        return null
      }
    },
    async confirmationKey(position: string, commitDigest: string) {
      return await access.read(async (group) => ({
        epoch: Number(group.epoch),
        key: await confirmationKey(group, position, commitDigest),
      }))
    },
    async sealRecoveryVerdict(request: Uint8Array, verdict: RecoveryVerdict) {
      return await access.read((group) =>
        sealRecoveryVerdict({
          group,
          identity,
          request: new TextDecoder().decode(request),
          verdict,
        }),
      )
    },
    async openRecoveryVerdict(
      sealed: Uint8Array,
      requestID: string,
      requestKey: Uint8Array,
    ): Promise<OpenedRecoveryVerdict | null> {
      if (params.recoveryAdoption !== undefined) {
        const { trust } = await params.recoveryAdoption.readRecoverySource()
        return await openRecoveryVerdictFromTrust({
          trust,
          sealed,
          requestID,
          requestKey,
          options: params.recoveryAdoption.environment.options,
        })
      }
      try {
        return await access.read((group) =>
          openRecoveryVerdict({ group, sealed, requestID, ephemeralPrivateKey: requestKey }),
        )
      } catch {
        return null
      }
    },
    async prepareRecovery(): Promise<'ready' | 'renewal-required'> {
      return await access.read((group) => recovery.prepare(group))
    },
    async readRecoverySource() {
      if (params.readRecoverySource !== undefined) {
        const source = await params.readRecoverySource()
        if (source.identity === null) throw new Error('Recovery source identity unavailable')
        // Legacy callers still consume the flattened identity until captured activation.
        return {
          ...source,
          epoch: source.identity.epoch,
          authenticator: source.identity.authenticator.slice(),
        }
      }
      return await access.readControl(async ({ handle, source }) => ({
        ...source,
        epoch: Number(handle.epoch),
        authenticator: handle.state.keySchedule.epochAuthenticator.slice(),
      }))
    },
    async readEpoch(): Promise<number> {
      return await access.read((group) => Number(group.epoch))
    },
    sendAdmission: () => access.admission(),
    ownCommitDigest,
    ...(params.onSafetyHold === undefined ? {} : { onSafetyHold: params.onSafetyHold }),
    async rosterEntries(): Promise<Array<RosterEntry>> {
      return await access.read((group) =>
        group.listMembers().map((member) => ({
          did: member.id,
          leafIndex: member.leafIndex,
          longForm: member.longForm,
        })),
      )
    },

    async readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null> {
      const header = await access.read(async (group) => {
        const header = await group.readCommitHeader(commit)
        if (
          header?.external !== true &&
          header?.committerDID !== undefined &&
          normalizeDID(header.committerDID) === normalizeDID(identity.id) &&
          !(await group.verifyCommitSignature(commit))
        )
          return { epoch: header.epoch }
        return header
      })
      if (header == null) return null
      return {
        epoch: Number(header.epoch),
        ...(header.committerDID != null && { committerDID: header.committerDID }),
        ...(header.external === true && { external: true }),
      }
    },

    validateRecoveryCommit(commit) {
      return access.read((group) => validateRecoveryCommit(group, commit, identity.id))
    },

    async processCommit(commit: Uint8Array, context: CommitContext): Promise<ProcessCommitResult> {
      const frameEpoch = readMessageEpoch(commit)
      const eligible = await access.read(async (group) => {
        let header: Awaited<ReturnType<GroupHandle['readCommitHeader']>>
        try {
          header = await group.readCommitHeader(commit)
        } catch (error) {
          if (error instanceof CommitValidationUnavailableError)
            return {
              eligible: false,
              epoch: Number(group.epoch),
              validation: 'unavailable' as const,
            }
          throw error
        }
        return {
          eligible: header?.committerDID !== undefined && frameEpoch === group.epoch,
          epoch: Number(group.epoch),
          refusal:
            header != null && frameEpoch === group.epoch && header.committerDID === undefined
              ? ('invalid' as const)
              : undefined,
        }
      })
      if (!eligible.eligible) {
        return {
          applied: false,
          advanced: false,
          epochBefore: eligible.epoch,
          epochAfter: eligible.epoch,
          ...(eligible.validation === undefined ? {} : { validation: eligible.validation }),
          ...(eligible.refusal === undefined ? {} : { refusal: eligible.refusal }),
        }
      }
      const ids = readCommitEntryIDs(commit)
      const tokens = ids.length === 0 ? [] : await context.resolveLedgerEntries?.(ids)
      const resolved = new Map<string, string>()
      for (const token of tokens ?? []) resolved.set(ledgerEntryDigest(token), token)
      const ignored = Symbol('ignored commit')
      let refusedEpoch: number | undefined
      let refusal: RecoveryRefusalReason | undefined
      let validation: 'unavailable' | undefined
      try {
        return await access.mutate(async (group, persist) => {
          if (group.epoch !== frameEpoch) {
            // Moved while entries resolved: the caller re-classifies against the epoch it names.
            refusedEpoch = Number(group.epoch)
            throw ignored
          }
          const result = await applyCommit({
            ...context,
            handle: group,
            commit,
            resolveLedgerEntries: async (requested) =>
              requested.flatMap((id) => {
                const token = resolved.get(id)
                return token == null ? [] : [token]
              }),
            entrySlot,
            ownDID: identity.id,
            persist,
          })
          // Thrown so the adapter does not save a handle the commit left untouched.
          if (!result.applied) {
            refusedEpoch = result.epochBefore
            refusal = result.refusal
            validation = result.validation
            throw ignored
          }
          return {
            applied: result.applied,
            advanced: result.advanced,
            epochBefore: result.epochBefore,
            epochAfter: result.epochAfter,
            ...(result.validation === undefined ? {} : { validation: result.validation }),
          }
        }, context.adoption)
      } catch (error) {
        if (error === ignored && refusedEpoch != null)
          return {
            applied: false,
            advanced: false,
            epochBefore: refusedEpoch,
            epochAfter: refusedEpoch,
            ...(refusal == null ? {} : { refusal }),
            ...(validation === undefined ? {} : { validation }),
          }
        throw error
      }
    },

    async createRecoveryRequest(requestID: string, deadlineMs?: number) {
      if (params.recoveryAdoption !== undefined) {
        const { trust } = await params.recoveryAdoption.readRecoverySource()
        return await createRecoveryRequestFromTrust({ trust, identity, requestID, deadlineMs })
      }
      const { request, ephemeralPrivateKey } = await access.read((group) =>
        createRecoveryRequest({
          group,
          identity,
          requestID,
        }),
      )
      return { request: utf8.encode(request), requestKey: ephemeralPrivateKey }
    },

    async sealGroupInfo(
      request: Uint8Array,
      captureHead?: LogPosition | null,
    ): Promise<Uint8Array> {
      if (captureHead !== undefined) {
        return await access.readControl(async (scope) => {
          const control = await scope.loadControl(params.control)
          if ((control.cursor?.position ?? null) !== captureHead)
            throw new Error('Capture head does not match the committed cursor')
          return await sealCapturedGroupInfo({
            group: scope.handle,
            identity,
            request: new TextDecoder().decode(request),
            captureHead,
          })
        })
      }
      // Throws for a request this member refuses — a removed requester holds no leaf in
      // this member's tree — and the peer stays silent. Roster-intrinsic, not a check here.
      return await access.read((group) =>
        sealGroupInfo({
          group,
          identity,
          request: new TextDecoder().decode(request),
        }),
      )
    },

    async applyRecovery(
      sealed: Uint8Array,
      requestID: string,
      requestKey: Uint8Array,
    ): Promise<AppliedRecovery> {
      let reply: RecoveryGroupInfo
      try {
        reply = await access.read((group) =>
          openRecoveryGroupInfo({
            group,
            sealed,
            requestID,
            ephemeralPrivateKey: requestKey,
          }),
        )
      } catch {
        // Bytes this peer cannot open OR cannot trust: a forged reply that merely decrypts
        // fails the membership attestation, and both are `null`.
        return null
      }
      const candidate = await access.read(async (group) => {
        const rejoined = await recovery.join(group, reply)
        if (rejoined == null || 'renewalRequired' in rejoined) return rejoined
        return {
          ...rejoined,
          knownRegistry: knownRecoveryRegistry(group.registry, rejoined.sourceRegistry),
        }
      })
      if (candidate == null || 'renewalRequired' in candidate) return candidate
      const rejoined = candidate
      if (
        rejoined.group.anchor.controller != null &&
        !recoverySignerEligible({
          group: rejoined.group,
          known: rejoined.knownRegistry,
          signer: reply.signer,
        })
      )
        return null
      return makeCandidate(
        {
          group: rejoined.group,
          sourceTree: rejoined.sourceTree,
          groupInfo: reply.groupInfo,
          knownRegistry: rejoined.knownRegistry,
          replyLedger: reply.ledger,
          signer: reply.signer,
          commit: rejoined.commitMessage,
          epoch: Number(rejoined.group.epoch),
        },
        requestID,
        requestKey,
      )
    },

    async restoreRecovery(bytes, requestKey) {
      const snapshot = decodeRecoveryCandidate(bytes, requestKey)
      const group = await access.read(async (current) => {
        const restored = await restoreGroup({
          state: snapshot.state,
          credential: current.credential,
          ledgerEntries: current.anchor.controller == null ? [] : snapshot.replyLedger,
          options: {
            ciphersuiteName: Object.keys(ciphersuites).find(
              (name) =>
                ciphersuites[name as keyof typeof ciphersuites] === current.context.cipherSuite.id,
            ),
            commitPolicy: current.commitPolicy,
            resolveLedgerEntries: current.resolveLedgerEntries,
            onLedgerEntries: current.onLedgerEntries,
          },
        })
        if (
          restored.groupID !== current.groupID ||
          !sameBytes(encodeGroupAnchor(restored.anchor), encodeGroupAnchor(current.anchor)) ||
          normalizeDID(
            restored
              .listMembers()
              .find((member) => member.leafIndex === restored.state.privatePath.leafIndex)?.id ??
              '',
          ) !== normalizeDID(identity.id)
        )
          throw new Error('Recovery candidate does not belong to this member and group')
        return restored
      })
      const candidate = makeCandidate(
        { ...snapshot, group },
        snapshot.requestID,
        requestKey,
        snapshot.boundCommit,
      )
      if (snapshot.boundCommit?.tag != null) {
        await candidate.confirmationKey(
          snapshot.boundCommit.position,
          snapshot.boundCommit.commitDigest,
        )
      }
      return candidate
    },

    async isLedgerComplete(): Promise<boolean> {
      return await access.read((group) => group.isLedgerComplete())
    },

    async getLedger(): Promise<Array<string>> {
      return await access.read((group) => group.getLedger())
    },

    async sealLedger(request: Uint8Array): Promise<Uint8Array> {
      return await access.read((group) =>
        sealLedger({ group, request: new TextDecoder().decode(request) }),
      )
    },

    async openSealedLedger(
      sealed: Uint8Array,
      requestID: string,
      requestKey: Uint8Array,
    ): Promise<Array<string> | null> {
      try {
        // The key is NOT consumed: every responder answers, and the requester must open the
        // next reply after dropping one.
        return await access.read((group) =>
          openSealedLedger({
            group,
            sealed,
            requestID,
            ephemeralPrivateKey: requestKey,
          }),
        )
      } catch {
        return null
      }
    },

    async bootstrapLedger(tokens: Array<string>): Promise<void> {
      // Throws for a list whose recomputed head does not match the authenticated one — a
      // lying responder can withhold, never rewrite.
      await access.mutate(async (group, persist) => {
        let persisted = false
        try {
          await group.bootstrapLedger(tokens, {
            persist: async (current) => {
              await persist(current)
              persisted = true
            },
          })
        } catch (error) {
          // A host callback after the write: the stored ledger is complete, so the adapter must
          // still publish this handle.
          if (!persisted) throw error
        }
      })
    },

    async exportRecoverySecret(): Promise<Uint8Array> {
      // Epoch-INDEPENDENT by construction: the genesis anchor never changes, so a peer
      // stranded at any epoch derives the same rendezvous. See the class doc — this is not
      // a confidential value.
      const secret =
        params.recoveryAdoption === undefined
          ? await access.read(params.recoverySecret ?? deriveRecoverySecret)
          : await (
              params.recoverySecretFromTrust ??
              ((trust) =>
                deriveRecoverySecretFromTrust(trust, params.recoveryAdoption?.environment.options))
            )((await params.recoveryAdoption.readRecoverySource()).trust)
      if (!(secret instanceof Uint8Array) || secret.length < MIN_RECOVERY_SECRET_BYTES) {
        throw new Error(
          `recoverySecret: expected at least ${MIN_RECOVERY_SECRET_BYTES} bytes from the host`,
        )
      }
      return secret
    },
  }
  groupHandleAccess.set(port, access)
  return port
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
