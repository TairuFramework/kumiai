import type { LogHub } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { AppWindowPruned } from '../../src/app-cursor.js'
import type { AppDeliveryResumed, AppDeliveryStalled } from '../../src/app-lane.js'
import type { AppOutbox } from '../../src/app-outbox.js'
import { digestAppliedCommit } from '../../src/classify.js'
import { encodeCommitFrame } from '../../src/commit-frame.js'
import type { HostBuilt, OperationDeps } from '../../src/control/operations.js'
import type {
  ControlStore,
  Operation,
  OperationRequest,
  Outcome,
  RejoinRecord,
  WelcomeObligation,
} from '../../src/control/types.js'
import { asLogPosition } from '../../src/cursor.js'
import { OperationRejectedError } from '../../src/errors.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import type { SubscribeFailure } from '../../src/hub-mux.js'
import { encodeLedgerEntries } from '../../src/ledger-entries.js'
import type { AppOutboxCleared } from '../../src/log-delivery.js'
import {
  createGroupPeerWithControlWalk,
  type GroupPeer,
  type RecoveryEvent,
  type StrandObservation,
} from '../../src/peer.js'
import type { GroupProtocolDefinition } from '../../src/protocol.js'
import { createMemoryAnchorStore, type MemoryAnchorStore } from './anchor.js'
import { createMemoryAppCursorStore, type MemoryAppCursorStore } from './app-cursor.js'
import { createFakeCrypto, type FakeCrypto } from './fake-crypto.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'
import {
  createMemoryGroupMLS,
  decodeMemoryGroupIdentity,
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
      ? Promise.resolve()
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
  const { peer, controlWalk } = createGroupPeerWithControlWalk<Protocols>({
    hub,
    crypto,
    mls,
    control,
    build: options.build ?? buildOperation,
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

export function memoryOperationHost(mls: MemoryGroupMLS) {
  const welcomes: Array<WelcomeObligation> = []
  return {
    welcomes,
    control: mls.control(),
    saveBuilt: mls.saveBuilt,
    build: (op: Operation) => buildMemoryOperation(mls, op),
    deliverWelcome: async (obligation: WelcomeObligation) => {
      welcomes.push(structuredClone(obligation))
    },
    adopt: (
      blob: Uint8Array,
      expected: Parameters<OperationDeps['adopt']>[1],
      write: Parameters<OperationDeps['adopt']>[2],
    ) => mls.adoptOperation(blob, expected, write),
  }
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
  const op = intent(request)
  const built = await member.buildOperation(op)
  const sealed = await member.crypto.sealEntries(encodeLedgerEntries(built.bodies))
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(built.commit, sealed.sealed),
  )
  const saved = {
    ...built,
    payload,
    payloadDigest: toB64U(sha256(payload)),
    publishID: crypto.randomUUID(),
    expectedHead: null,
    searchFrom: null,
  }
  const row: Operation =
    acceptedAs == null
      ? { ...op, stage: 'built', built: saved }
      : { ...op, stage: 'accepted', built: saved, acceptedAs: asLogPosition(acceptedAs) }
  await member.control.apply({ putOperations: [row] }, crypto.randomUUID())
  return row
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
