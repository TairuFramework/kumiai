import type { LogHub } from '@kumiai/hub-tunnel'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import type { CommitOnceEvidence, CommitOnceScenario } from '@kumiai/rpc-conformance'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { vi } from 'vitest'

import type { AppWindowPruned } from '../../src/app-cursor.js'
import type { AppDeliveryResumed, AppDeliveryStalled } from '../../src/app-lane.js'
import type { AppOutbox } from '../../src/app-outbox.js'
import { digestAppliedCommit } from '../../src/classify.js'
import { decodeCommitFrame, encodeCommitFrame } from '../../src/commit-frame.js'
import type { FrameControlBuild } from '../../src/control/build.js'
import type { HostBuilt, OperationDeps } from '../../src/control/operations.js'
import type { ControlEvidenceSnapshot, ControlValidationPort } from '../../src/control/search.js'
import { controlBuildRef } from '../../src/control/slot.js'
import type {
  ControlSlot,
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
  RejoinRecord,
  WelcomeObligation,
} from '../../src/control/types.js'
import { asLogPosition } from '../../src/cursor.js'
import { OperationRejectedError } from '../../src/errors.js'
import { decodeHandshakeFrame, encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import type { SubscribeFailure } from '../../src/hub-mux.js'
import { createLedgerEntryResolver, encodeLedgerEntries } from '../../src/ledger-entries.js'
import type { AppOutboxCleared } from '../../src/log-delivery.js'
import type { GroupPeer, RecoveryEvent, StrandObservation } from '../../src/peer.js'
import type { GroupProtocolDefinition } from '../../src/protocol.js'
import { commitTopic } from '../../src/topic.js'
import { createMemoryAnchorStore, type MemoryAnchorStore } from './anchor.js'
import { createMemoryAppCursorStore, type MemoryAppCursorStore } from './app-cursor.js'
import { createFakeCrypto, type FakeCrypto } from './fake-crypto.js'
import { FakeHub } from './fake-hub.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'
import {
  createMemoryGroupMLS,
  decodeMemoryCommit,
  decodeMemoryControlJournal,
  decodeMemoryGroupIdentity,
  encodeMemoryControlJournal,
  type MemoryGroupMLS,
} from './memory-group-mls.js'
import { createMemoryAppOutbox } from './outbox.js'

/**
 * `chat/changed` is EPHEMERAL — live push, nothing retained, nothing drainable — and every test
 * that uses it depends on that. `chat/posted` is the retained one, alongside it rather than
 * instead of it: flipping `chat/changed` would quietly hand a log to tests written about a
 * mailbox, and both classes sharing one topic is the real shape anyway.
 */
export const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
  'chat/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
  'chat/echo': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies GroupProtocolDefinition

export type Protocols = { chat: typeof chat }

export type TestPeer = {
  validation: ControlValidationPort
  controlWalk: ReturnType<typeof createGroupPeerWithControlWalk<Protocols>>['controlWalk']
  peer: GroupPeer<Protocols>
  crypto: FakeCrypto
  mls: MemoryGroupMLS
  database: MemoryHostDatabase
  control: ControlStore
  buildOptions: Map<string, LedgerCommitOptions>
  initialState: Uint8Array
  buildOperation: (op: Operation) => Promise<HostBuilt>
  anchorStore: MemoryAnchorStore
  appOutbox: AppOutbox
  appCursorStore: MemoryAppCursorStore
  /** Every Welcome this host delivered, in order. Records the at-least-once repeats too. */
  welcomes: Array<string>
}

export type MakeMLSPeerOptions = {
  appOutbox?: AppOutbox
  appOutboxLimit?: number
  onAppOutboxCleared?: (notice: AppOutboxCleared) => void | Promise<void>
  epoch?: number
  /** Entry bodies this member already holds — a Welcome carries them. Not an enacted ledger. */
  bodies?: Array<string>
  /** The members this handle's tree holds a leaf for. A responder seals only to those. */
  members?: Array<string>
  /** Restart over the durable database and app stores. */
  restartOf?: TestPeer
  /** Reuse an existing group state without a restart — a peer built over a handle made here. */
  mls?: MemoryGroupMLS
  crypto?: FakeCrypto
  database?: MemoryHostDatabase
  control?: ControlStore
  build?: (op: Operation) => Promise<HostBuilt>
  adopt?: OperationDeps['adopt']
  /**
   * Reuse an existing anchor store. The store must OUTLIVE the peer: the anchor is persisted
   * state a rebooted handle can never re-export, so a restart that does not carry the store
   * forward is a peer that partitions from its own group.
   */
  anchorStore?: MemoryAnchorStore
  /**
   * Reuse an existing app-lane cursor store. It must OUTLIVE the peer, like the anchor store: a
   * read position that dies with the process leaves the drain unable to tell where it got to from
   * where the hub's retention now begins.
   */
  appCursorStore?: MemoryAppCursorStore
  /** The host's notice that an app topic's retention floor passed this peer's read position. */
  onAppWindowPruned?: (event: AppWindowPruned) => void
  onStrand?: (observation: StrandObservation) => void | Promise<void>
  onOutcome?: (outcome: Outcome) => void | Promise<void>
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  onAppDeliveryStalled?: (event: AppDeliveryStalled) => void
  onAppDeliveryResumed?: (event: AppDeliveryResumed) => void
  /** The host's notice that a subscribe was refused or exhausted its retries. */
  onSubscribeFailed?: (failure: SubscribeFailure) => void
  deliverWelcome?: (obligation: WelcomeObligation) => Promise<void>
  welcomes?: Array<string>
  /** The host's own app-protocol handlers. Without them the app lane delivers to nobody. */
  handlers?: Record<string, unknown>
  operationTimeoutMs?: number
  /** The group's commit policy: a committer this refuses is well-formed and not applied. */
  acceptsCommitter?: (committerDID: string) => boolean
  recovery?: { timeoutMs?: number; getDelayMs?: () => number; deadlineMs?: number }
}

/** A member of the group at `epoch`, wired with durable control, as a host must be. */
export function makeMLSPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  options: MakeMLSPeerOptions = {},
): TestPeer {
  const epoch = options.epoch ?? 1
  const restartOf = options.restartOf
  const database =
    options.database ??
    restartOf?.database ??
    options.mls?.database() ??
    createMemoryHostDatabase({
      readIdentity: (state, key) => decodeMemoryGroupIdentity(state, key, recoverySecret),
    })
  const crypto =
    options.crypto ?? restartOf?.crypto.restart() ?? createFakeCrypto({ epoch, localDID })
  const mls =
    options.mls ??
    createMemoryGroupMLS({
      hostDB: database,
      storageID: localDID,
      recoverySecret,
      epoch,
      localDID,
      ...(options.bodies != null ? { bodies: options.bodies } : {}),
      ...(options.members != null ? { members: options.members } : {}),
      ...(options.acceptsCommitter != null ? { acceptsCommitter: options.acceptsCommitter } : {}),
      onAdvance: (e) => crypto.setEpoch(e),
    })
  const control = options.control ?? mls.control()
  const initialState = restartOf?.initialState ?? mls.serializeState()
  const restore =
    restartOf == null
      ? mls.persistInitialState()
      : database.loadState(localDID).then((state) => {
          mls.restoreState(state ?? initialState)
          crypto.setEpoch(mls.epoch())
        })
  const readEpoch = mls.readEpoch.bind(mls)
  mls.readEpoch = async () => {
    await restore
    return readEpoch()
  }
  const readRecoverySource = mls.readRecoverySource.bind(mls)
  mls.readRecoverySource = async () => {
    await restore
    return readRecoverySource()
  }
  const exportSecret = crypto.exportSecret.bind(crypto)
  crypto.exportSecret = async (label) => {
    await restore
    return exportSecret(label)
  }
  const buildOptions = new Map<string, LedgerCommitOptions>()
  const buildOperation = async (op: Operation): Promise<HostBuilt> => {
    const hooks = buildOptions.get(op.id)
    await hooks?.onBuild?.()
    hooks?.framedAt?.push(mls.epoch())
    const built = await buildMemoryOperation(mls, op)
    return hooks?.transform == null ? built : hooks.transform(built)
  }
  const anchorStore =
    options.anchorStore ??
    restartOf?.anchorStore ??
    createMemoryAnchorStore({ backing: mls.anchorStore() })
  anchorStore.connect(mls.anchorStore())
  const appCursorStore =
    options.appCursorStore ?? restartOf?.appCursorStore ?? createMemoryAppCursorStore()
  const appOutbox = options.appOutbox ?? restartOf?.appOutbox ?? createMemoryAppOutbox()
  const welcomes = options.welcomes ?? restartOf?.welcomes ?? []
  const ports = memoryControlPorts(mls, crypto, options.build ?? buildOperation, recoverySecret)
  const { peer, controlWalk } = createGroupPeerWithControlWalk<Protocols>({
    hub,
    crypto,
    mls,
    control,
    ...ports,
    deliverWelcome:
      options.deliverWelcome ??
      (async (row) => {
        welcomes.push(row.opID)
      }),
    adopt:
      options.adopt ??
      ((blob, expected, write) => {
        const id = write.changes.putOutcomes?.[0]?.opID
        const hook = id == null ? undefined : buildOptions.get(id)?.onAdopt
        const adopt = () => mls.adoptOperation(blob, expected, write)
        return hook == null ? adopt() : hook(adopt)
      }),
    anchorStore,
    appCursorStore,
    appOutbox,
    appOutboxLimit: options.appOutboxLimit ?? 128,
    ...(options.onAppOutboxCleared != null
      ? { onAppOutboxCleared: options.onAppOutboxCleared }
      : {}),
    ...(options.onAppWindowPruned != null ? { onAppWindowPruned: options.onAppWindowPruned } : {}),
    ...(options.onStrand != null ? { onStrand: options.onStrand } : {}),
    ...(options.onRecovery != null ? { onRecovery: options.onRecovery } : {}),
    ...(options.onOutcome != null ? { onOutcome: options.onOutcome } : {}),
    ...(options.onAppDeliveryStalled != null
      ? { onAppDeliveryStalled: options.onAppDeliveryStalled }
      : {}),
    ...(options.onAppDeliveryResumed != null
      ? { onAppDeliveryResumed: options.onAppDeliveryResumed }
      : {}),
    ...(options.onSubscribeFailed != null ? { onSubscribeFailed: options.onSubscribeFailed } : {}),
    localDID,
    protocols: { chat },
    handlers: { chat: options.handlers ?? {} } as never,
    ...(options.operationTimeoutMs != null
      ? { operationTimeoutMs: options.operationTimeoutMs }
      : {}),
    ...(options.recovery != null ? { recovery: options.recovery } : {}),
  })
  return {
    validation: ports.validation,
    controlWalk,
    peer,
    crypto,
    mls,
    database,
    control,
    initialState,
    buildOptions,
    buildOperation,
    anchorStore,
    appCursorStore,
    appOutbox,
    welcomes,
  }
}

export type LedgerCommitOptions = {
  /** Records the epoch each attempt framed at: a rebased retry must frame at the new one. */
  framedAt?: Array<number>
  onAdopt?: (
    adopt: () => Promise<'installed' | 'noop' | 'moved'>,
  ) => Promise<'installed' | 'noop' | 'moved'>
  revokes?: boolean
  transform?: (built: HostBuilt) => HostBuilt | Promise<HostBuilt>
  /** Runs inside build(), before the commit is produced. */
  onBuild?: () => void | Promise<void>
}

export async function reconstructMemoryPeer(
  hub: LogHub,
  localDID: string,
  recoverySecret: Uint8Array,
  database: MemoryHostDatabase,
  options: Omit<MakeMLSPeerOptions, 'restartOf' | 'mls' | 'crypto' | 'database'> = {},
): Promise<TestPeer> {
  const state = await database.loadState(localDID)
  if (state === null) throw new Error('No committed state to reconstruct')
  const crypto = createFakeCrypto({ localDID })
  const mls = createMemoryGroupMLS({
    hostDB: database,
    storageID: localDID,
    localDID,
    recoverySecret,
    onAdvance: (epoch) => crypto.setEpoch(epoch),
  })
  mls.restoreState(state)
  crypto.setEpoch(mls.epoch())
  return makeMLSPeer(hub, localDID, recoverySecret, { ...options, database, mls, crypto })
}

function operation(
  member: TestPeer,
  kind: OperationRequest['kind'],
  body: { tokens: Array<string>; target?: string },
  options: LedgerCommitOptions,
): OperationRequest {
  const id = crypto.randomUUID()
  member.buildOptions.set(id, options)
  return {
    id,
    kind,
    revokes: options.revokes ?? kind === 'remove',
    body: new TextEncoder().encode(JSON.stringify(body)),
  }
}

export function buildLedgerCommit(
  member: TestPeer,
  tokens: Array<string>,
  options: LedgerCommitOptions = {},
): OperationRequest {
  return operation(member, 'ledger', { tokens }, options)
}
export function buildRemoveCommit(
  member: TestPeer,
  victimDID: string,
  options: LedgerCommitOptions = {},
): OperationRequest {
  return operation(member, 'remove', { tokens: [], target: victimDID }, options)
}
export function buildInviteCommit(
  member: TestPeer,
  inviteeDID: string,
  options: LedgerCommitOptions = {},
): OperationRequest {
  return operation(member, 'invite', { tokens: [], target: inviteeDID }, options)
}

export async function buildMemoryOperation(mls: MemoryGroupMLS, op: Operation): Promise<HostBuilt> {
  const body = JSON.parse(new TextDecoder().decode(op.body)) as {
    tokens: Array<string>
    target?: string
  }
  if (op.kind === 'invite' && body.target != null && mls.leaves().includes(body.target))
    throw new OperationRejectedError('Already a member')
  if (op.kind === 'remove' && body.target != null && !mls.leaves().includes(body.target))
    throw new OperationRejectedError('Already removed')
  const before = mls.serializeState()
  const epoch = mls.epoch()
  const authenticatorBefore = mls.authenticator()
  const commit = mls.buildCommit(body.tokens, {
    ...(op.kind === 'invite' && body.target != null ? { adds: [body.target] } : {}),
    ...(op.kind === 'remove' && body.target != null ? { removes: [body.target] } : {}),
  })
  mls.adopt(commit)
  const journal = mls.serializeState()
  mls.restoreState(before)
  return {
    commit,
    bodies: body.tokens,
    journal,
    epoch,
    authenticatorBefore,
    incarnation: 1,
    digest: digestAppliedCommit(commit),
    welcome:
      op.kind === 'invite' && body.target != null
        ? { bytes: new TextEncoder().encode(body.target), recipients: [body.target] }
        : null,
  }
}

export function memoryControlPorts(
  mls: MemoryGroupMLS,
  crypto: FakeCrypto,
  build: (op: Operation) => Promise<HostBuilt>,
  recoverySecret?: Uint8Array,
) {
  const control = mls.control()
  const validation: ControlValidationPort = {
    restoreValidation: async (built) => {
      let journal: ReturnType<typeof decodeMemoryControlJournal>
      try {
        journal = decodeMemoryControlJournal(built.journal)
      } catch {
        return null
      }
      const identity = journal.source.identity
      if (
        identity === null ||
        identity.epoch !== built.epoch ||
        identity.incarnation !== built.incarnation ||
        toB64U(identity.authenticator) !== toB64U(built.authenticatorBefore) ||
        toB64U(sha256(built.payload)) !== built.payloadDigest
      )
        return null
      const retainedSecret = recoverySecret ?? (await mls.exportRecoverySecret())
      const retainedCrypto = crypto.restart()
      retainedCrypto.setEpoch(identity.epoch)
      const source = () => {
        const handle = createMemoryGroupMLS({
          groupID: identity.groupID,
          recoverySecret: retainedSecret,
          acceptsCommitter: mls.acceptsCommitter,
        })
        handle.restoreState(journal.sourceState)
        return handle
      }
      const check = async (payload: Uint8Array) => {
        const commit = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
        const parsed = decodeMemoryCommit(commit.commit)
        const handle = source()
        const result = await handle.processCommit(commit.commit, {
          resolveLedgerEntries: createLedgerEntryResolver(
            commit.sealedEntries,
            retainedCrypto.openEntries,
          ),
        })
        return { parsed, handle, result }
      }
      return {
        source: journal.source,
        readCommitHeader: (commit) => source().readCommitHeader(commit),
        validateFrame: async (frame) => {
          const commit = decodeCommitFrame(decodeHandshakeFrame(frame.payload).payload).commit
          const parsed = decodeMemoryCommit(commit)
          if (parsed === null) return { kind: 'invalid', reason: 'malformed' }
          if (parsed.missingProposal) return { kind: 'unavailable', reason: 'missing-proposal' }
          if (
            parsed.invalidContent ||
            (parsed.signerDID ?? parsed.committerDID) !== parsed.committerDID
          )
            return { kind: 'invalid', reason: 'authentication' }
          try {
            const checked = await check(frame.payload)
            if (!checked.result.applied) return { kind: 'invalid', reason: 'policy' }
            return {
              kind: 'valid',
              header: {
                epoch: parsed.epoch,
                committerDID: parsed.committerDID,
                ...(parsed.external ? { external: true } : {}),
              },
              own: !parsed.external && parsed.committerDID === mls.credentialDID(),
              advanced: checked.result.advanced,
              removed: false,
            }
          } catch {
            return { kind: 'unavailable', reason: 'resolver' }
          }
        },
        verifyOwn: async (value) => {
          if (value.payloadDigest !== built.payloadDigest) return false
          const checked = await check(value.payload)
          const candidate = decodeMemoryGroupIdentity(
            journal.candidate,
            journal.source.key,
            retainedSecret,
          )
          return (
            checked.parsed?.external !== true &&
            checked.parsed?.committerDID === mls.credentialDID() &&
            checked.result.applied &&
            candidate?.epoch === identity.epoch + 1 &&
            toB64U(candidate.authenticator) === toB64U(checked.handle.authenticator())
          )
        },
      }
    },
  }
  return {
    validation,
    readEvidence: mls.readEvidence,
    prepareBuild: async (op: Operation, frame: FrameControlBuild) => {
      await mls.persistInitialState()
      const snapshot = await control.load()
      if (op.stage !== 'intent' || snapshot.operations[0]?.id !== op.id)
        return { kind: 'moved' as const, operation: op }
      if (Date.now() >= op.deadline) return { kind: 'expired' as const, operation: op }
      const source = await mls.readRecoverySource()
      if (snapshot.controlHold !== null || snapshot.commitOnce?.epoch === source.epoch)
        return { kind: 'occupied' as const, operation: op }
      const sourceState = mls.serializeState()
      const retainedCrypto = crypto.restart()
      retainedCrypto.setEpoch(source.epoch)
      try {
        const host = await build(op)
        const sameSource = async () => {
          const current = await mls.readRecoverySource()
          return (
            current.key.groupID === source.key.groupID &&
            current.key.incarnation === source.key.incarnation &&
            current.epoch === source.epoch &&
            toB64U(current.authenticator) === toB64U(source.authenticator)
          )
        }
        if (
          host.epoch !== source.epoch ||
          host.incarnation !== source.key.incarnation ||
          toB64U(host.authenticatorBefore) !== toB64U(source.authenticator) ||
          !(await sameSource())
        )
          return { kind: 'moved' as const, operation: op }
        const framed = await frame(host, retainedCrypto.sealEntries)
        if (Date.now() >= op.deadline) return { kind: 'expired' as const, operation: op }
        if (!(await sameSource())) return { kind: 'moved' as const, operation: op }
        const slot: ControlSlot = {
          ...host,
          ...framed,
          opID: op.id,
          searchFrom: snapshot.cursor?.position ?? null,
          payloadDigest: toB64U(sha256(framed.payload)),
          journal: encodeMemoryControlJournal({ source, sourceState, candidate: host.journal }),
        }
        const result = await mls.saveBuilt(op, slot, source, globalThis.crypto.randomUUID())
        return {
          kind: result,
          operation:
            result === 'saved'
              ? { ...op, stage: 'built' as const, built: controlBuildRef(slot) }
              : op,
        }
      } catch (error) {
        if (
          error instanceof OperationRejectedError ||
          (error instanceof Error && error.name === 'FrameTooLargeError')
        )
          return { kind: 'rejected' as const, operation: op, reason: error.message }
        throw error
      }
    },
  }
}

export function memoryOperationHost(mls: MemoryGroupMLS) {
  const welcomes: Array<WelcomeObligation> = []
  const crypto = createFakeCrypto({ epoch: mls.epoch() })
  const host = {
    ...memoryControlPorts(mls, crypto, (op): Promise<HostBuilt> => host.build(op)),
    welcomes,
    control: mls.control(),
    saveBuilt: mls.saveBuilt,
    build: (op: Operation) => buildMemoryOperation(mls, op),
    deliverWelcome: async (obligation: WelcomeObligation) => {
      welcomes.push(structuredClone(obligation))
    },
    adopt: mls.adoptOperation,
  }
  return host
}
export function intent(request: OperationRequest): Operation {
  return {
    ...request,
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
    stage: 'intent',
  }
}

export async function seedBuiltOperation(
  member: TestPeer,
  request: OperationRequest,
  acceptedAs?: string,
) {
  await member.mls.persistInitialState()
  const op = intent(request)
  await member.control.apply({ putOperations: [op] }, crypto.randomUUID())
  const ports = memoryControlPorts(member.mls, member.crypto, member.buildOperation)
  const result = await ports.prepareBuild(op, async (host, seal) => {
    const sealed = await seal(encodeLedgerEntries(host.bodies))
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(host.commit, sealed.sealed),
    )
    return { payload, publishID: crypto.randomUUID(), expectedHead: member.controlWalk.head() }
  })
  if (result.kind !== 'saved') throw new Error(`Build was ${result.kind}`)
  const slot = (await member.control.load()).commitOnce
  if (slot === null) throw new Error('missing slot')
  const proof = {
    source: (await member.mls.readEvidence()).source,
    from: slot.searchFrom,
    position: asLogPosition(acceptedAs ?? '000000000001'),
    payloadDigest: slot.payloadDigest,
  }
  const row: Operation =
    acceptedAs === undefined
      ? result.operation
      : {
          ...result.operation,
          stage: 'accepted',
          built: controlBuildRef(slot),
          acceptedAs: proof.position,
          acceptance: proof,
        }
  if (acceptedAs !== undefined)
    await member.control.apply(
      { putOperations: [row], commitOnceAcceptance: proof },
      crypto.randomUUID(),
    )
  return Object.defineProperty(row, 'slot', { value: slot }) as Operation & { slot: ControlSlot }
}

export async function buildRejoinRecord(member: TestPeer): Promise<RejoinRecord> {
  const id = crypto.randomUUID()
  const { request, requestKey } = await member.mls.createRecoveryRequest(id)
  const pending = await member.mls.applyRecovery(
    await member.mls.sealGroupInfo(request),
    id,
    requestKey,
  )
  if (pending == null || 'renewalRequired' in pending) throw new Error('Missing recovery candidate')
  const { sealed } = await member.crypto.sealEntries(encodeLedgerEntries([]))
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, sealed),
  )
  return {
    id,
    stage: 'built',
    publishID: crypto.randomUUID(),
    expectedHead: null,
    payload,
    payloadDigest: toB64U(sha256(payload)),
    requestID: id,
    request,
    requestKey,
    candidate: pending.serialize(),
    source: {
      epoch: member.mls.epoch(),
      authenticator: member.mls.authenticator(),
      key: (await member.mls.readRecoverySource()).key,
      head: null,
    },
    digest: digestAppliedCommit(pending.commit),
    epochAfter: pending.epoch,
    ledgerBefore: await member.mls.getLedger(),
    conflictEpoch: null,
  }
}

export type CommitOnceTestHost = {
  control: ControlStore
  prepareBuild: OperationDeps['prepareBuild']
  adopt: OperationDeps['adopt']
  validation: ControlValidationPort
  readEvidence(): Promise<ControlEvidenceSnapshot>
  peer: GroupPeer<Protocols>
  controlWalk: TestPeer['controlWalk']
  request: OperationRequest
  competing(kind: 'member' | 'public' | 'remove' | 'unavailable'): Promise<Uint8Array>
  receiver(slot: ControlSlot): Promise<boolean>
  reopen(): Promise<CommitOnceTestHost>
  progress(): Promise<() => Promise<boolean>>
  setGap(value: boolean): void
  deleteGroup(): Promise<void>
  close(): Promise<void>
}

export async function runCommitOnceHost(
  scenario: CommitOnceScenario,
  create: (observe: {
    built(): void
    adopted(): void
    delivered(): void
    outcome(value: Outcome): void
    published(payload: Uint8Array, id: string, head: string | null): void
  }) => Promise<CommitOnceTestHost>,
  hub: LogHub,
  topicID: string,
  localDID: string,
): Promise<CommitOnceEvidence> {
  let builds = 0
  let ownAdoptions = 0
  let welcomeDeliveries = 0
  let publicationsBeforeProof = 0
  let builtProven = false
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const payloads: Array<Uint8Array> = []
  const publishIDs: Array<string> = []
  const expectedHeads: Array<string | null> = []
  const published = (payload: Uint8Array, id: string, head: string | null) => {
    if (!builtProven) publicationsBeforeProof++
    payloads.push(payload.slice())
    publishIDs.push(id)
    expectedHeads.push(head)
  }
  const emitted: Array<Outcome> = []
  let host = await create({
    built: () => {
      builds++
    },
    adopted: () => {
      ownAdoptions++
    },
    delivered: () => {
      welcomeDeliveries++
    },
    published,
    outcome: (value) => emitted.push(value),
  })
  const append = (payload: Uint8Array, publishID = crypto.randomUUID()) =>
    hub.publish({
      senderDID: localDID,
      topicID,
      payload,
      publishID,
      retain: 'log',
    })
  let progressPreserved = false
  let checkProgress: (() => Promise<boolean>) | undefined
  try {
    await host.peer.resync()
    if (scenario === 'trimmed-checkpoint') {
      await append(new Uint8Array([255]))
      await host.peer.resync()
    }
    const op: Operation & { stage: 'intent' } = {
      ...host.request,
      seq: 1,
      enqueuedAt: now,
      deadline: now + 30_000,
      stage: 'intent',
    }
    await host.control.apply({ putOperations: [op] }, crypto.randomUUID())
    let operation = await host.controlWalk.stepOperation(op.id)
    const slot = (await host.control.load()).commitOnce
    if (slot === null || operation === null || operation.stage !== 'built')
      throw new Error('Missing saved build')
    builtProven = true
    const searchFrom = slot.searchFrom
    let winner: string | null = null
    if (scenario === 'progress') checkProgress = await host.progress()
    if (
      scenario === 'alternate-id-replay' ||
      scenario === 'public-member-winner' ||
      scenario === 'terminal-winner'
    ) {
      winner = (
        await append(
          await host.competing(
            scenario === 'terminal-winner'
              ? 'remove'
              : scenario === 'public-member-winner'
                ? 'public'
                : 'member',
          ),
        )
      ).sequenceID
      await append(slot.payload)
    } else if (scenario === 'epoch-move') {
      await append(await host.competing('member'))
    } else if (scenario === 'validation-unavailable') {
      await append(await host.competing('unavailable'))
      await append(slot.payload)
      now = op.deadline
    } else if (
      scenario === 'gap-match' ||
      scenario === 'trimmed-checkpoint' ||
      scenario === 'accepted-restart'
    ) {
      await append(slot.payload)
      if (scenario === 'accepted-restart') {
        const found = await host.controlWalk.searchLog(slot)
        if (found.kind !== 'first-valid') throw new Error('Search did not prove acceptance')
        const proof = found.proof
        await host.control.apply(
          {
            commitOnceAcceptance: proof,
            putOperations: [
              { ...operation, stage: 'accepted', acceptedAs: proof.position, acceptance: proof },
            ],
          },
          crypto.randomUUID(),
        )
      }
      host.setGap(true)
      now = op.deadline
    } else if (scenario === 'late-acked-slot') {
      host.setGap(true)
      now = op.deadline
      await host.controlWalk.stepOperation(operation.id)
      await host.control.apply({ deleteOutcomes: [op.id] }, crypto.randomUUID())
      host.setGap(false)
      await append(slot.payload)
    } else if (scenario === 'deadline' || scenario === 'slot-guards') {
      now = op.deadline
    }
    if (scenario === 'slot-guards') {
      operation = await host.controlWalk.stepOperation(operation.id)
      const queued: Operation & { stage: 'intent' } = {
        ...op,
        id: crypto.randomUUID(),
        seq: 2,
        enqueuedAt: now,
        deadline: now + 30_000,
      }
      await host.control.apply({ putOperations: [queued] }, crypto.randomUUID())
      await host.controlWalk.stepOperation(queued.id)
      await host.control.apply(
        {
          deleteOperations: [queued.id],
          putOutcomes: [
            {
              id: queued.id,
              opID: queued.id,
              kind: 'rejected',
              at: now,
              reason: 'Host authorization changed',
            },
          ],
        },
        crypto.randomUUID(),
      )
      await host.control.apply(
        { putOperations: [{ ...queued, id: crypto.randomUUID(), seq: 3 }] },
        crypto.randomUUID(),
      )
      await host.peer.abandon()
      try {
        await host.deleteGroup()
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'GroupControlUnsettledError') throw error
      }
    }
    if (scenario === 'built-restart' && operation !== null)
      operation = await host.controlWalk.stepOperation(operation.id)
    // A restart restores only committed rows; observations remain outside the reconstructed host.
    if (
      scenario === 'built-restart' ||
      scenario === 'accepted-restart' ||
      scenario === 'deadline' ||
      scenario === 'late-acked-slot'
    ) {
      await host.close()
      host = await host.reopen()
      await host.peer.replay()
      operation = (await host.control.load()).operations[0] ?? null
    }
    if (scenario === 'late-acked-slot') {
      await host.peer.replay()
    } else {
      for (let i = 0; operation !== null && i < 6; i++) {
        const next = await host.controlWalk.stepOperation(operation.id)
        operation = next
      }
    }
    if (checkProgress !== undefined) progressPreserved = await checkProgress()
    const facts = (await host.control.load()).outcomes
    const last = facts.filter((row) => row.opID === op.id).at(-1)
    const noticed = emitted.some((row) => row.id === last?.id && row.kind === last?.kind)
    const outcome =
      noticed && (last?.kind === 'landed' || last?.kind === 'lost') ? last.kind : 'unknown'
    await host.control.apply({ deleteOutcomes: facts.map((row) => row.id) }, crypto.randomUUID())
    const evidence = await host.readEvidence()
    return {
      outcome,
      builds,
      ownAdoptions,
      welcomeDeliveries,
      payloads,
      publishIDs,
      expectedHeads,
      searchFrom,
      slotAfterAck: (await host.control.load()).commitOnce,
      winnerFollowed: winner !== null && evidence.applied.some((row) => row.sequenceID === winner),
      candidateMatchesReceiver:
        outcome === 'landed' &&
        (await host.receiver(
          scenario === 'epoch-move'
            ? {
                ...slot,
                epoch: slot.epoch + 1,
                payload: payloads[payloads.length - 1] ?? slot.payload,
              }
            : slot,
        )),
      progressPreserved,
      cursor: evidence.cursor?.position ?? null,
      terminal: evidence.terminal,
      publicationsBeforeProof,
    }
  } finally {
    await host.close()
    clock.mockRestore()
  }
}

export async function runMemoryCommitOnceScenario(
  scenario: CommitOnceScenario,
): Promise<CommitOnceEvidence> {
  if (scenario === 'ownership-conflict')
    throw new Error('Sealed provider scenario lives in mls-rpc')
  const secret = new Uint8Array(32).fill(0x6c)
  const hub = new FakeHub()
  const database = createMemoryHostDatabase()
  const localDID = 'alice'
  const members = ['alice', 'bob', 'carol']
  return runCommitOnceHost(
    scenario,
    async (observe) => {
      let networkGap = false
      let failPublish = scenario === 'poison-head' || scenario === 'built-restart'
      const view: LogHub = {
        subscribe: hub.subscribe.bind(hub),
        unsubscribe: hub.unsubscribe.bind(hub),
        receive: hub.receive.bind(hub),
        fetchTopic: async (params) => ({
          ...(await hub.fetchTopic(params)),
          ...(networkGap ? { gap: true } : {}),
        }),
        publish: async (params) => {
          if (params.topicID === commitTopic(secret))
            observe.published(
              params.payload,
              params.publishID ?? globalThis.crypto.randomUUID(),
              params.expectedHead ?? null,
            )
          if (params.topicID === commitTopic(secret) && failPublish) {
            failPublish = false
            await hub.publish({
              topicID: params.topicID,
              senderDID: localDID,
              payload: new Uint8Array([255, 255]),
              retain: 'log',
            })
          }
          return hub.publish(params)
        },
      }
      const create = async (restore: boolean): Promise<CommitOnceTestHost> => {
        const crypto = createFakeCrypto({ localDID, epoch: 1 })
        const mls = createMemoryGroupMLS({
          hostDB: database,
          storageID: localDID,
          localDID,
          recoverySecret: secret,
          members,
          epoch: 1,
          onAdvance: (epoch) => crypto.setEpoch(epoch),
        })
        if (restore) {
          const state = await database.loadState(localDID)
          if (state === null) throw new Error('Missing committed memory state')
          mls.restoreState(state)
        }
        crypto.setEpoch(mls.epoch())
        const build = async (op: Operation) => {
          observe.built()
          return buildMemoryOperation(mls, op)
        }
        const adopt: OperationDeps['adopt'] = async (bytes, expected, write) => {
          const result = await mls.adoptOperation(bytes, expected, write)
          if (result === 'installed') observe.adopted()
          return result
        }
        const member = makeMLSPeer(view, localDID, secret, {
          database,
          mls,
          crypto,
          build,
          adopt,
          operationTimeoutMs: restore ? 90_000 : 30_000,
          onOutcome: observe.outcome,
          deliverWelcome: async () => {
            observe.delivered()
          },
        })
        const ports = memoryControlPorts(mls, crypto, build, secret)
        const competitors: Array<Uint8Array> = []
        const request: OperationRequest = {
          id: globalThis.crypto.randomUUID(),
          kind: 'invite',
          revokes: false,
          body: new TextEncoder().encode(JSON.stringify({ tokens: [], target: 'dave' })),
        }
        return {
          ...ports,
          adopt,
          peer: member.peer,
          controlWalk: member.controlWalk,
          control: member.control,
          request,
          reopen: () => create(true),
          deleteGroup: () => database.delete(localDID),
          setGap: (value) => {
            networkGap = value
          },
          competing: async (kind) => {
            const author = createMemoryGroupMLS({
              localDID: 'bob',
              recoverySecret: secret,
              members,
              epoch: 1,
            })
            const commit = author.buildCommit([], kind === 'remove' ? { removes: [localDID] } : {})
            let bytes = commit
            if (kind === 'unavailable') {
              const value = JSON.parse(new TextDecoder().decode(commit)) as Record<string, unknown>
              bytes = new TextEncoder().encode(JSON.stringify({ ...value, missingProposal: true }))
            }
            const sealed = await createFakeCrypto({ localDID: 'bob', epoch: 1 }).sealEntries(
              encodeLedgerEntries([]),
            )
            const payload = encodeHandshakeFrame(
              HANDSHAKE_KIND.commit,
              encodeCommitFrame(bytes, sealed.sealed),
            )
            competitors.push(payload)
            return payload
          },
          receiver: async (slot) => {
            const receiver = createMemoryGroupMLS({
              localDID: 'carol',
              recoverySecret: secret,
              members,
              epoch: 1,
            })
            for (const payload of competitors)
              await receiver.processCommit(
                decodeCommitFrame(decodeHandshakeFrame(payload).payload).commit,
                {},
              )
            const decoded = decodeCommitFrame(decodeHandshakeFrame(slot.payload).payload)
            const result = await receiver.processCommit(decoded.commit, {})
            return (
              result.applied && toB64U(receiver.authenticator()) === toB64U(mls.authenticator())
            )
          },
          progress: async () => {
            const sender = createFakeCrypto({ epoch: mls.epoch(), localDID: 'bob' })
            const frame = await sender.wrap(new Uint8Array([7]))
            await crypto.unwrap(frame)
            const before = JSON.parse(new TextDecoder().decode(crypto.saveState())) as {
              generation: number
              spent: Array<string>
            }
            return async () => {
              const after = JSON.parse(
                new TextDecoder().decode(crypto.saveState()),
              ) as typeof before
              return (
                after.generation === before.generation &&
                JSON.stringify(after.spent) === JSON.stringify(before.spent)
              )
            }
          },
          close: async () => {
            await member.peer.dispose()
            await member.peer.drained()
          },
        }
      }
      return create(false)
    },
    hub,
    commitTopic(secret),
    localDID,
  )
}
