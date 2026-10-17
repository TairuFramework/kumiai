import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  commitInvite,
  commitKeyRotation,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  encodeControlEnvelope,
  type GroupHandle,
  type Invite,
  type KeyPackageBundle,
  ledgerEntryDigest,
  processWelcome,
  ROLE_ENTRY_TYPE,
  removeMember,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  buildRevokeProofOnHandle,
  buildRevokeProofOperation,
  createControlAdoptionPort,
  createControlBuildPort,
  createControlValidationPort,
  createGroupCrypto,
  createGroupMLS,
  createLedgerEntrySlot,
  deriveRecoverySecret,
  type GroupMLSDependencies,
  type GroupMLSParams,
  type HandleAccess,
  InvalidCandidateError,
  type LedgerEntrySlot,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import type {
  AdoptionWrite,
  Anchor,
  AnchorSlot,
  AnchorStore,
  AppCursorStore,
  AppOutbox,
  ControlBuildPort,
  ControlEvidenceSnapshot,
  ControlStore,
  GroupKey,
  GroupMLS,
  GroupPeer,
  GroupProtocolDefinition,
  HostBuilt,
  Operation,
  OperationRequest,
  Outcome,
  PendingAppFrame,
  RecoveryEvent,
  WelcomeObligation,
} from '@kumiai/rpc'
import {
  commitTopic,
  createLedgerEntryResolver,
  decodeCommitFrame,
  decodeHandshakeFrame,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
  OperationRejectedError,
} from '@kumiai/rpc'
import { createGroupPeerWithControlWalk } from '@kumiai/rpc/testing'
import {
  type CommitOnceEvidence,
  type CommitOnceScenario,
  createMemoryAppOutbox,
} from '@kumiai/rpc-conformance'
import { createCommit, encode, mlsMessageEncoder } from 'ts-mls'

import {
  bareTestHandle,
  buildRealUnavailableCommit,
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from '../../../packages/mls-rpc/test/fixtures/real-group.js'
import {
  type CommitOnceTestHost,
  runCommitOnceHost,
} from '../../../packages/rpc/test/fixtures/peer.js'
import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'
import type { WireHub } from './log-hub-over-wire.js'
import { createWireHub } from './log-hub-over-wire.js'

export { createMemoryAppOutbox }

/**
 * The app protocol under test: one logged procedure, one ephemeral one beside it, and one
 * REQUEST — the directed lane's, which runs over the members' inbox topics rather than the app
 * topic. A member supplies a handler only for what it answers, so adding this costs the
 * event-lane tests nothing.
 */
export const chat = {
  'chat/changed': { type: 'event', data: { type: 'object' } },
  'chat/posted': { type: 'event', retain: 'log', data: { type: 'object' } },
  'chat/double': { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies GroupProtocolDefinition

export type Protocols = { chat: typeof chat }

// ---------------------------------------------------------------------------
// Host-side durable stores. These are the HOST's storage, not doubles of any
// component under test: the peer, the hub, the MLS handles and the crypto are
// all real, and a host has to put its anchor, cursor and control records somewhere.
// ---------------------------------------------------------------------------

export function createMemoryAnchorStore(
  backing?: AnchorStore,
): AnchorStore & { stored: () => Anchor | null } {
  let slot: AnchorSlot | null = null
  return {
    load: async () => {
      if (backing != null) slot = await backing.load()
      return slot
    },
    save: async (next: AnchorSlot) => {
      await backing?.save(next)
      slot = next
    },
    stored: () => slot?.anchor ?? null,
  }
}

export function createMemoryAppCursorStore(): AppCursorStore & {
  stored: (topicID: string) => string | null
} {
  const positions = new Map<string, string>()
  return {
    load: async (topicID: string) => positions.get(topicID) ?? null,
    save: async (topicID: string, position: string) => {
      const held = positions.get(topicID)
      // A read position only ever moves forward. The rule lives in the peer, so the store
      // is the only thing in a position to catch a regression that wrote one backwards.
      if (held != null && position < held) {
        throw new Error(`app cursor for ${topicID} may not move back from ${held} to ${position}`)
      }
      positions.set(topicID, position)
    },
    stored: (topicID) => positions.get(topicID) ?? null,
  }
}

export function encodeJournal(derived: GroupHandle): Uint8Array {
  return encodeStoredState(encodeClientState(derived.state), derived.ledgerTokens)
}

function encodeStoredState(state: Uint8Array, ledger: Array<string>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      state: Array.from(state),
      ledger,
    }),
  )
}

/**
 * The host's durable MLS state, in memory: the serialized ClientState plus the ledger
 * tokens needed to rebuild the roster. A restart is `restoreGroup` over exactly this.
 */
export type StateStore = {
  database: MemoryHostDatabase
  control: ControlStore
  save: (handle: GroupHandle, write?: AdoptionWrite) => Promise<void>
  saveOpened: (state: Uint8Array, ledger: Array<string>) => Promise<void>
  readEvidence(): Promise<ControlEvidenceSnapshot>
  saved: () => Promise<{ state: Uint8Array; ledger: Array<string> } | null>
}

export function createMemoryStateStore(
  key: GroupKey = { groupID: 'state', incarnation: 1 },
  retainedDatabase?: MemoryHostDatabase,
): StateStore {
  const database =
    retainedDatabase ??
    createMemoryHostDatabase({
      readIdentity: (blob, key) => {
        const journal = JSON.parse(new TextDecoder().decode(blob)) as { state: Array<number> }
        const state = decodeClientState(Uint8Array.from(journal.state))
        if (state == null) throw new Error('Invalid stored MLS state')
        return {
          groupID: new TextDecoder().decode(state.groupContext.groupId),
          incarnation: key.incarnation,
          epoch: Number(state.groupContext.epoch),
          authenticator: state.keySchedule.epochAuthenticator.slice(),
        }
      },
    })
  const control = database.control('state', key)
  return {
    database,
    control,
    save: async (handle, write) => {
      try {
        await database.saveState('state', encodeJournal(handle), write)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== 'StorageOutcomeUnknownError' ||
          write == null ||
          (await control.lastMutation()) !== write.mutationID
        )
          throw error
      }
    },
    readEvidence: async () => {
      const row = await database.snapshot('state')
      const saved = row.state === null ? null : decodeStoredState(row.state)
      const state = saved === null ? null : decodeClientState(saved.state)
      return {
        source: {
          key: control.key,
          stateVersion: row.version,
          identity:
            state == null
              ? null
              : {
                  ...control.key,
                  epoch: Number(state.groupContext.epoch),
                  authenticator: state.keySchedule.epochAuthenticator.slice(),
                },
        },
        applied: row.control.applied,
        cursor: row.control.cursor,
        terminal: state?.groupActiveState.kind === 'removedFromGroup',
      }
    },
    saveOpened: (state, ledger) => database.saveState('state', encodeStoredState(state, ledger)),
    saved: async () => {
      const blob = await database.loadState('state')
      if (blob == null) return null
      const saved = JSON.parse(new TextDecoder().decode(blob)) as {
        state: Array<number>
        ledger: Array<string>
      }
      return { state: new Uint8Array(saved.state), ledger: saved.ledger }
    },
  }
}

// ---------------------------------------------------------------------------
// A member: real MLS handle, real ports, real peer, real hub connection.
// ---------------------------------------------------------------------------

export type Member = {
  hostHooks: {
    afterAdopt?: (next: GroupHandle) => void | Promise<void>
    beforeBuild?: () => void
    serializeJournal?: (next: GroupHandle) => Uint8Array | Promise<Uint8Array>
  }
  controlWalk: ReturnType<typeof createGroupPeerWithControlWalk<Protocols>>['controlWalk']
  validation: ReturnType<typeof createControlValidationPort>
  adoptControl: ReturnType<typeof createControlAdoptionPort>['adopt']
  identity: OwnIdentity
  mls: GroupMLS
  crypto: ReturnType<typeof createGroupCrypto>
  peer: GroupPeer<Protocols>
  handle: () => GroupHandle
  adopt: (handle: GroupHandle) => Promise<void>
  anchorStore: ReturnType<typeof createMemoryAnchorStore>
  appOutbox: AppOutbox
  appCursorStore: ReturnType<typeof createMemoryAppCursorStore>
  control: ControlStore
  build: (op: Operation, group?: GroupHandle) => Promise<HostBuilt>
  prepareBuild: ControlBuildPort['prepareBuild']
  builders: Map<string, (op: Operation, group: GroupHandle) => Promise<HostBuilt>>
  signers: Map<string, OwnIdentity>
  deliveries: Map<string, (welcome: Uint8Array) => void>
  stateStore: StateStore
  pendingStore?: Map<string, PendingAppFrame>
  entrySlot: LedgerEntrySlot
  /**
   * Drop this member's hub connection — the other half of a process dying. Disposing the peer
   * stops the peer; it does not take the socket down.
   *
   * A restart no longer NEEDS this: the hub still binds one receive writer per DID, but the
   * newest channel takes the lane rather than being refused it (see `HubClientRegistry`), which
   * is what a real reconnect after a dropped connection depends on. Dropping the socket is still
   * the honest way to model a dead process, and `directed-lane`/`app-lane` use it for that.
   */
  disconnect: () => Promise<void>
}

export type MakeMemberParams = {
  hub: WireHub
  identity: OwnIdentity
  group: GroupHandle
  entrySlot: LedgerEntrySlot
  handlers?: Record<string, unknown>
  /** Carry a dead member's durable state forward — this is what a restart IS. */
  restartOf?: Member
  deliverWelcome?: (obligation: WelcomeObligation) => Promise<void>
  beforeAdopt?: (next: GroupHandle) => void | Promise<void>
  onControlAdopt?: () => void
  stateStore?: StateStore
  operationTimeoutMs?: number
  durablePending?: boolean
  recoveryBinding?: GroupMLSParams['recoveryBinding']
  recovery?: { timeoutMs?: number; deadlineMs?: number; getDelayMs?: () => number }
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  onOutcome?: (outcome: Outcome) => void | Promise<void>
}

export function makeMember(params: MakeMemberParams): Member {
  const { hub, identity, entrySlot, restartOf } = params
  let handle = params.group
  const hostHooks: Member['hostHooks'] = {}
  const appCursorStore = restartOf?.appCursorStore ?? createMemoryAppCursorStore()
  const stateStore =
    params.stateStore ??
    restartOf?.stateStore ??
    createMemoryStateStore({ groupID: handle.groupID, incarnation: 1 })
  const anchorStore =
    restartOf?.anchorStore ?? createMemoryAnchorStore(stateStore.database.anchorStore('state'))
  const pendingStore =
    restartOf?.pendingStore ??
    (params.durablePending ? new Map<string, PendingAppFrame>() : undefined)

  const getHandle = () => handle
  const adoptHandle = async (next: GroupHandle) => {
    await params.beforeAdopt?.(next)
    handle = next
    await hostHooks.afterAdopt?.(next)
  }
  if (params.stateStore === undefined) void stateStore.save(handle)

  const access = simpleHandleAccess({
    key: stateStore.control.key,
    handle: getHandle,
    stateVersion: () => stateStore.database.loadVersion('state'),
    adopt: adoptHandle,
    persist: (next, write) => stateStore.save(next, write),
  })
  const adopt = (next: GroupHandle) => access.replace(next)
  const pending =
    pendingStore == null
      ? undefined
      : {
          persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
            await stateStore.saveOpened(state, handle.ledgerTokens)
            pendingStore.set(record.frame.id, record)
          },
          list: async () => [...pendingStore.values()],
          complete: async (id: string) => {
            pendingStore.delete(id)
          },
        }
  const crypto = createGroupCrypto({ access, pending })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access, stateStore.control),
    identity,
    entrySlot,
    recoveryBinding: params.recoveryBinding,
  })

  const control = stateStore.control
  const builders =
    restartOf?.builders ??
    new Map<string, (op: Operation, group: GroupHandle) => Promise<HostBuilt>>()
  const signers = restartOf?.signers ?? new Map([[identity.id, identity]])
  const deliveries = new Map<string, (welcome: Uint8Array) => void>()
  const build = async (op: Operation, supplied?: GroupHandle): Promise<HostBuilt> => {
    hostHooks.beforeBuild?.()
    const custom = builders.get(op.id)
    if (custom != null) return custom(op, supplied ?? (await bareTestHandle(handle)))
    const body = decodeOperationBody(op.body) as {
      type: string
      target?: string
      tokens?: Array<string>
      material?: InviteMaterial
      subject?: string
      value?: string
      signer?: string
    }
    let committed: { commitMessage: Uint8Array; newGroup: GroupHandle }
    let bodies: Array<string> = []
    let welcome: HostBuilt['welcome'] = null
    const current = supplied ?? (await bareTestHandle(handle))
    if (body.type === 'invite' && body.material != null) {
      const result = await commitInvite(
        current,
        body.material.bundle.publicPackage,
        body.material.invite,
      )
      committed = result
      bodies = body.material.invite.ledgerEntries
      welcome = {
        bytes: result.welcomeMessage,
        recipients: [body.material.invite.recipientDID],
      }
    } else if (body.type === 'remove' && body.target != null) {
      const leaf = current.findMemberLeafIndex(body.target)
      if (leaf == null) throw new OperationRejectedError('Already removed')
      committed = await removeMember(current, leaf)
    } else if (body.type === 'role' && body.subject != null && body.value != null) {
      bodies = [
        await signLedgerEntry(signers.get(body.signer ?? identity.id) ?? identity, {
          type: ROLE_ENTRY_TYPE,
          groupID: current.groupID,
          subject: body.subject,
          value: body.value,
        }),
      ]
      committed = await commitLedgerEntries(current, bodies)
    } else if (body.type === 'revoke-proof') {
      const options = { serializeJournal: hostHooks.serializeJournal ?? encodeJournal }
      return supplied === undefined
        ? buildRevokeProofOperation({ mls, group: current, op, options })
        : buildRevokeProofOnHandle({ group: supplied, incarnation: 1, op, options })
    } else {
      bodies = body.tokens ?? []
      committed = await commitLedgerEntries(current, bodies)
    }
    return {
      commit: committed.commitMessage,
      bodies,
      journal: encodeJournal(committed.newGroup),
      welcome,
      epoch: Number(current.epoch),
      authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
      incarnation: 1,
      digest: digestAppliedCommit(committed.commitMessage),
    }
  }
  const buildPort = createControlBuildPort({
    restoreCandidate: (bytes) => restoreCandidate(bytes),
    access,
    control,
    build,
    saveBuilt: (intent, built, expected, mutationID) => {
      const body = decodeOperationBody(intent.body) as { material?: InviteMaterial }
      // Assemble the transport envelope after receipt validation. The Welcome embeds its tree.
      const retained =
        built.welcome === null || body.material === undefined
          ? built
          : {
              ...built,
              welcome: {
                ...built.welcome,
                bytes: encodeOperationBody({
                  welcome: built.welcome.bytes,
                  invite: body.material.invite,
                }),
              },
            }
      return stateStore.database.saveBuilt(
        'state',
        control.key,
        intent,
        retained,
        expected,
        mutationID,
      )
    },
    now: () => Date.now(),
    newID: () => globalThis.crypto.randomUUID(),
  })
  const restoreCandidate = candidateRestorer(access, { resolveLedgerEntries: entrySlot.resolve })
  const adoption = createControlAdoptionPort({ access, control, restoreCandidate })
  const validation = createControlValidationPort({
    identity,
    options: { resolveLedgerEntries: entrySlot.resolve },
    restoreCandidate,
  })
  const connection = hub.connect(identity)
  const appOutbox = restartOf?.appOutbox ?? createMemoryAppOutbox()
  const adoptControl: ReturnType<typeof createControlAdoptionPort>['adopt'] = async (
    bytes,
    expected,
    write,
  ) => {
    const result = await adoption.adopt(bytes, expected, write)
    if (result === 'installed') params.onControlAdopt?.()
    return result
  }
  const { peer, controlWalk } = createGroupPeerWithControlWalk<Protocols>({
    appOutboxLimit: 128,
    onRecovery: params.onRecovery,
    onOutcome: params.onOutcome,
    recovery: params.recovery,
    hub: connection,
    crypto,
    mls,
    control,
    prepareBuild: buildPort.prepareBuild,
    validation,
    readEvidence: stateStore.readEvidence,
    anchorStore,
    appCursorStore,
    appOutbox,
    localDID: identity.id,
    protocols: { chat },
    handlers: { chat: params.handlers ?? {} } as never,
    adopt: adoptControl,
    operationTimeoutMs: params.operationTimeoutMs,
    deliverWelcome:
      params.deliverWelcome ??
      (async (obligation) => {
        const deliver = deliveries.get(obligation.opID)
        if (deliver == null) throw new Error('Invitation transport unavailable')
        deliver(obligation.welcome)
      }),
  })

  return {
    hostHooks,
    controlWalk,
    validation,
    adoptControl,
    identity,
    mls,
    crypto,
    peer,
    handle: getHandle,
    adopt,
    anchorStore,
    appCursorStore,
    appOutbox,
    control,
    build,
    prepareBuild: buildPort.prepareBuild,
    builders,
    deliveries,
    signers,
    stateStore,
    pendingStore,
    entrySlot,
    disconnect: connection.disconnect,
  }
}

/** Restore a member's handle from what its dead process persisted. */
export async function restoreMemberHandle(
  member: Member,
  entrySlot: LedgerEntrySlot,
): Promise<GroupHandle> {
  const saved = await member.stateStore.saved()
  if (saved == null) throw new Error('nothing persisted')
  const state = decodeClientState(saved.state) as ClientState
  return await restoreGroup({
    state,
    credential: member.handle().credential,
    ledgerEntries: saved.ledger,
    options: { resolveLedgerEntries: entrySlot.resolve },
  })
}

// ---------------------------------------------------------------------------
// Group construction — real invites, real Welcomes, real commits.
// ---------------------------------------------------------------------------

/** The shared entry-body store every member resolves a commit's named entries against. */
export function createEntryBodies() {
  const tokens = new Map<string, string>()
  return {
    publish: (invite: Invite) => {
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
    },
    get: (id: string) => tokens.get(id),
    all: () => [...tokens.values()],
  }
}

export type GroupBuilder = ReturnType<typeof createEntryBodies>

export async function createFoundingGroup(
  creator: OwnIdentity,
  groupID: string,
  entrySlot: LedgerEntrySlot,
): Promise<GroupHandle> {
  const { group } = await createGroup(creator, groupID, {
    resolveLedgerEntries: entrySlot.resolve,
  })
  return group
}

export type InviteMaterial = {
  invite: Invite
  bundle: KeyPackageBundle
}

export async function mintInvite(params: {
  admin: GroupHandle
  adminIdentity: OwnIdentity
  invitee: OwnIdentity
  bodies: GroupBuilder
}): Promise<InviteMaterial> {
  const { invite } = await createInvite({
    group: params.admin,
    identity: params.adminIdentity,
    recipientDID: params.invitee.id,
    permission: 'member',
  })
  params.bodies.publish(invite)
  const bundle = await createKeyPackageBundle(params.invitee)
  return { invite, bundle }
}

export function encodeOperationBody(body: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(body, (_key, value) =>
      value instanceof Uint8Array
        ? { bytes: [...value] }
        : typeof value === 'bigint'
          ? { bigint: value.toString() }
          : value,
    ),
  )
}
function decodeOperationBody(body: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(body), (_key, value) =>
    value?.bytes != null
      ? new Uint8Array(value.bytes)
      : value?.bigint != null
        ? BigInt(value.bigint)
        : value,
  )
}
export function operationRequest(
  kind: OperationRequest['kind'],
  body: unknown,
  revokes = false,
): OperationRequest {
  return { id: crypto.randomUUID(), kind, revokes, body: encodeOperationBody(body) }
}
export function buildInviteCommit(
  member: Member,
  material: InviteMaterial,
  deliverWelcome: (welcome: Uint8Array) => void,
): OperationRequest {
  const request = operationRequest('invite', { type: 'invite', material })
  member.deliveries.set(request.id, (artifact) => {
    const decoded = decodeOperationBody(artifact) as { welcome: Uint8Array }
    deliverWelcome(decoded.welcome)
  })
  return request
}
export function buildRemoveCommit(_member: Member, victimDID: string): OperationRequest {
  return operationRequest('remove', { type: 'remove', target: victimDID }, true)
}
export function buildLedgerCommit(
  member: Member,
  identity: OwnIdentity,
  subject: string,
  value: string,
): OperationRequest {
  member.signers.set(identity.id, identity)
  return operationRequest('ledger', { type: 'role', subject, value, signer: identity.id })
}
export function customOperation(
  member: Member,
  builder: (op: Operation, group: GroupHandle) => Promise<HostBuilt>,
): OperationRequest {
  const request = operationRequest('ledger', { tokens: [] })
  member.builders.set(request.id, builder)
  return request
}
export function operationIntent(request: OperationRequest): Operation {
  return {
    ...request,
    seq: 1,
    enqueuedAt: Date.now(),
    deadline: Date.now() + 30_000,
    stage: 'intent',
  }
}

export async function joinFromWelcome(params: {
  identity: OwnIdentity
  invite: Invite
  welcome: Uint8Array
  bundle: KeyPackageBundle
  ratchetTree: GroupHandle['state']['ratchetTree']
  entrySlot: LedgerEntrySlot
}): Promise<GroupHandle> {
  const { group } = await processWelcome({
    identity: params.identity,
    invite: params.invite,
    welcome: params.welcome,
    keyPackageBundle: params.bundle,
    ratchetTree: params.ratchetTree,
    options: { resolveLedgerEntries: params.entrySlot.resolve },
  })
  return group
}

export function newIdentity(): OwnIdentity {
  return randomIdentity()
}

const operationStores = new WeakMap<HandleAccess, StateStore>()

export function groupMLSDependencies(
  access: HandleAccess,
): GroupMLSDependencies & { access: HandleAccess } {
  const store = operationStores.get(access)
  if (store === undefined) throw new Error('Missing durable control store')
  return { ...testGroupMLSDependencies(access, store.control), access }
}

export async function createDurableHandleAccess(
  params: Pick<Parameters<typeof simpleHandleAccess>[0], 'handle' | 'adopt'>,
): Promise<HandleAccess> {
  const store = createMemoryStateStore({ groupID: params.handle().groupID, incarnation: 1 })
  await store.save(params.handle())
  const access = simpleHandleAccess({
    key: store.control.key,
    ...params,
    persist: store.save,
    stateVersion: () => store.database.loadVersion('state'),
  })
  operationStores.set(access, store)
  return access
}

export function createOperationHost(access: HandleAccess, identity: OwnIdentity) {
  const welcomes: Array<WelcomeObligation> = []
  const store = operationStores.get(access)
  if (store === undefined) throw new Error('Operation host requires durable handle access')
  const builders = new Map<string, (op: Operation, group: GroupHandle) => Promise<HostBuilt>>()
  const build = async (op: Operation, group: GroupHandle) => {
    const builder = builders.get(op.id)
    if (builder === undefined) throw new OperationRejectedError('No host builder')
    return builder(op, group)
  }
  const restoreCandidate = candidateRestorer(access)
  const control = store.control
  const buildPort = createControlBuildPort({
    restoreCandidate: (bytes) => restoreCandidate(bytes),
    access,
    control,
    build,
    saveBuilt: (intent, built, expected, mutationID) =>
      store.database.saveBuilt('state', control.key, intent, built, expected, mutationID),
    now: Date.now,
    newID: () => crypto.randomUUID(),
  })
  return {
    builders,
    welcomes,
    control,
    build,
    prepareBuild: buildPort.prepareBuild,
    validation: createControlValidationPort({ identity, options: {}, restoreCandidate }),
    readEvidence: store.readEvidence,
    deliverWelcome: async (obligation: WelcomeObligation) => {
      welcomes.push(structuredClone(obligation))
    },
    anchorStore: createMemoryAnchorStore(store.database.anchorStore('state')),
    adopt: createControlAdoptionPort({ access, control, restoreCandidate }).adopt,
  }
}

function decodeStoredState(blob: Uint8Array): { state: Uint8Array; ledger: Array<string> } {
  const saved = JSON.parse(new TextDecoder().decode(blob)) as {
    state: Array<number>
    ledger: Array<string>
  }
  return { state: Uint8Array.from(saved.state), ledger: saved.ledger }
}

function candidateRestorer(
  access: HandleAccess,
  options: Parameters<typeof restoreGroup>[0]['options'] = {},
) {
  return async (candidate: Uint8Array) => {
    let saved: ReturnType<typeof decodeStoredState>
    try {
      saved = decodeStoredState(candidate)
    } catch (cause) {
      throw new InvalidCandidateError('Invalid candidate envelope', { cause })
    }
    const state = decodeClientState(saved.state)
    if (state == null) throw new InvalidCandidateError('Invalid candidate state')
    const credential = await access.read((handle) => handle.credential)
    return restoreGroup({ state, credential, ledgerEntries: saved.ledger, options })
  }
}

export async function runRealCommitOnceScenario(
  scenario: CommitOnceScenario,
): Promise<CommitOnceEvidence> {
  if (scenario === 'ownership-conflict') {
    const { runControlProofConflict } = await import(
      '../../../packages/mls-rpc/test/fixtures/storage-persistence.js'
    )
    return runControlProofConflict('real-mls')
  }
  const group = await createRealGroup(2, `commit-once-${scenario}`)
  const identity = group.committer.identity
  if (scenario === 'terminal-winner') {
    const author = group.members[0]
    if (author === undefined) throw new Error('Missing removal author')
    const role = await signLedgerEntry(identity, {
      type: ROLE_ENTRY_TYPE,
      groupID: group.committer.handle.groupID,
      subject: author.identity.id,
      value: 'admin',
    })
    group.bodies.set(ledgerEntryDigest(role), role)
    const committed = await commitLedgerEntries(group.committer.handle, [role])
    group.committer.handle = committed.newGroup
    for (const member of group.members) await member.handle.processMessage(committed.commitMessage)
  }
  const wire = createWireHub()
  const publisher = wire.connect(identity)
  const secret = await deriveRecoverySecret(group.committer.handle)
  const topicID = commitTopic(secret)
  const store = createMemoryStateStore({ groupID: group.committer.handle.groupID, incarnation: 1 })
  await store.save(group.committer.handle)
  const invitee = randomIdentity()
  const { invite } = await createInvite({
    group: group.committer.handle,
    identity,
    recipientDID: invitee.id,
    permission: 'member',
  })
  const bundle = await createKeyPackageBundle(invitee)
  const request = operationRequest('invite', { type: 'invite', material: { invite, bundle } })
  try {
    return await runCommitOnceHost(
      scenario,
      async (observe) => {
        let networkGap = false
        let failPublish = scenario === 'poison-head' || scenario === 'built-restart'
        const view: WireHub = {
          dispose: wire.dispose,
          connect: (identity) => {
            const connection = wire.connect(identity)
            return {
              ...connection,
              fetchTopic: async (params) => ({
                ...(await connection.fetchTopic(params)),
                ...(networkGap ? { gap: true } : {}),
              }),
              publish: async (params) => {
                if (params.topicID === topicID)
                  observe.published(
                    params.payload,
                    params.publishID ?? crypto.randomUUID(),
                    params.expectedHead ?? null,
                  )
                if (params.topicID === topicID && failPublish) {
                  failPublish = false
                  await connection.publish({
                    topicID,
                    senderDID: identity.id,
                    payload: new Uint8Array([255, 255]),
                    retain: 'log',
                  })
                }
                return connection.publish(params)
              },
            }
          },
        }
        const create = async (restore: boolean): Promise<CommitOnceTestHost> => {
          const stateStore = createMemoryStateStore(store.control.key, store.database)
          const entrySlot = createLedgerEntrySlot()
          const saved = await stateStore.saved()
          if (saved === null) throw new Error('Missing committed MLS state')
          const state = decodeClientState(saved.state)
          if (state === undefined) throw new Error('Invalid committed MLS state')
          const handle = await restoreGroup({
            state,
            credential: { id: identity.id, groupID: stateStore.control.key.groupID },
            ledgerEntries: saved.ledger,
            options: { resolveLedgerEntries: entrySlot.resolve },
          })
          const member = makeMember({
            hub: view,
            identity,
            group: handle,
            entrySlot,
            stateStore,
            operationTimeoutMs: restore ? 90_000 : 30_000,
            onControlAdopt: observe.adopted,
            onOutcome: observe.outcome,
            deliverWelcome: async () => {
              observe.delivered()
            },
          })
          member.hostHooks.beforeBuild = observe.built
          const competitors: Array<Uint8Array> = []
          return {
            control: member.control,
            prepareBuild: member.prepareBuild,
            adopt: member.adoptControl,
            validation: member.validation,
            readEvidence: stateStore.readEvidence,
            peer: member.peer,
            controlWalk: member.controlWalk,
            request,
            reopen: () => create(true),
            deleteGroup: () => store.database.delete('state'),
            setGap: (value) => {
              networkGap = value
            },
            competing: async (kind) => {
              const author = group.members[0]
              if (author === undefined) throw new Error('Missing competitor')
              let commit: Uint8Array
              let entries: Array<string> = []
              if (kind === 'unavailable')
                commit = await buildRealUnavailableCommit({
                  ...group,
                  committer: author,
                  members: [group.committer],
                })
              else if (kind === 'remove') {
                const leaf = author.handle.findMemberLeafIndex(identity.id)
                if (leaf == null) throw new Error('Missing target leaf')
                entries = [
                  await signLedgerEntry(author.identity, {
                    type: ROLE_ENTRY_TYPE,
                    groupID: author.handle.groupID,
                    subject: identity.id,
                    value: 'member',
                  }),
                ]
                commit = (await removeMember(author.handle, leaf, entries)).commitMessage
              } else if (kind === 'public') {
                const result = await createCommit({
                  context: author.handle.context,
                  state: { ...author.handle.state, unappliedProposals: {} },
                  extraProposals: [],
                  wireAsPublicMessage: true,
                  authenticatedData: encodeControlEnvelope({ v: 1 }),
                })
                commit = encode(mlsMessageEncoder, result.commit)
              } else commit = (await commitKeyRotation(author.handle)).commitMessage
              const crypto = createGroupCrypto({
                access: testHandleAccess({
                  handle: () => author.handle,
                  adopt: (next) => {
                    author.handle = next
                  },
                  persist: async () => {},
                }),
              })
              const sealed = await crypto.sealEntries(encodeLedgerEntries(entries))
              const payload = encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(commit, sealed.sealed),
              )
              competitors.push(payload)
              return payload
            },
            receiver: async (slot) => {
              const receiver = group.members[1]
              if (receiver === undefined) throw new Error('Missing receiver')
              const access = testHandleAccess({
                handle: () => receiver.handle,
                adopt: (next) => {
                  receiver.handle = next
                },
                persist: async () => {},
              })
              const mls = createGroupMLS({
                ...testGroupMLSDependencies(access),
                identity: receiver.identity,
                entrySlot: receiver.slot,
              })
              const crypto = createGroupCrypto({ access })
              for (const payload of competitors) {
                const prior = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
                await mls.processCommit(prior.commit, {
                  resolveLedgerEntries: createLedgerEntryResolver(
                    prior.sealedEntries,
                    crypto.openEntries,
                  ),
                })
              }
              const frame = decodeCommitFrame(decodeHandshakeFrame(slot.payload).payload)
              const result = await mls.processCommit(frame.commit, {
                resolveLedgerEntries: createLedgerEntryResolver(
                  frame.sealedEntries,
                  crypto.openEntries,
                ),
              })
              const source = await member.mls.readRecoverySource()
              if (source.identity === null) return false
              return (
                result.applied &&
                source.identity.authenticator.every(
                  (byte, index) =>
                    byte === receiver.handle.state.keySchedule.epochAuthenticator[index],
                )
              )
            },
            progress: async () => {
              const sender = group.members[0]
              if (sender === undefined) throw new Error('Missing sender')
              const bytes = await sender.handle.encrypt(new Uint8Array([7]))
              await member.crypto.unwrap(bytes)
              await member.crypto.wrap(new Uint8Array([8]))
              const sourceEpoch = member.handle().epoch
              const ownLeaf = member.handle().state.privatePath.leafIndex * 2
              const before =
                member.handle().state.secretTree.leafNodes[ownLeaf]?.application.generation
              return async () => {
                let refused = false
                try {
                  await member.crypto.unwrap(bytes)
                } catch {
                  refused = true
                }
                return (
                  refused &&
                  member.handle().state.historicalReceiverData.get(sourceEpoch)?.secretTree
                    .leafNodes[ownLeaf]?.application.generation === before
                )
              }
            },
            close: async () => {
              await member.peer.dispose()
              await member.peer.drained()
              await member.disconnect()
            },
          }
        }
        return create(false)
      },
      publisher,
      topicID,
      identity.id,
    )
  } finally {
    await wire.dispose()
  }
}
