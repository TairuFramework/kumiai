import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ClientState,
  commitInvite,
  commitLedgerEntries,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
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
  buildRevokeProofOperation,
  createGroupCrypto,
  createGroupMLS,
  type GroupMLSParams,
  type HandleAccess,
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
  ControlStore,
  GroupMLS,
  GroupPeer,
  GroupProtocolDefinition,
  HostBuilt,
  Operation,
  OperationRequest,
  PendingAppFrame,
  RecoveryEvent,
} from '@kumiai/rpc'
import { createGroupPeer, digestAppliedCommit, OperationRejectedError } from '@kumiai/rpc'
import { createMemoryAppOutbox } from '@kumiai/rpc-conformance'

import { createMemoryHostDatabase, type MemoryHostDatabase } from './host-db.js'
import type { WireHub } from './log-hub-over-wire.js'

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
// all real, and a host has to put its anchor, cursor and journal somewhere.
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
  return new TextEncoder().encode(
    JSON.stringify({
      state: Array.from(encodeClientState(derived.state)),
      ledger: derived.ledgerTokens,
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
  saveOpened: (state: Uint8Array, ledger: Array<string>) => void
  saved: () => { state: Uint8Array; ledger: Array<string> } | null
}

export function createMemoryStateStore(): StateStore {
  const database = createMemoryHostDatabase()
  const control = database.control('state')
  let blob: { state: Uint8Array; ledger: Array<string> } | null = null
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
      blob = { state: encodeClientState(handle.state), ledger: [...handle.ledgerTokens] }
    },
    saveOpened: (state, ledger) => {
      blob = { state: state.slice(), ledger: [...ledger] }
    },
    saved: () => blob,
  }
}

// ---------------------------------------------------------------------------
// A member: real MLS handle, real ports, real peer, real hub connection.
// ---------------------------------------------------------------------------

export type Member = {
  hostHooks: {
    afterAdopt?: (next: GroupHandle) => void | Promise<void>
    serializeJournal?: (next: GroupHandle) => Uint8Array | Promise<Uint8Array>
  }
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
  build: (op: Operation) => Promise<HostBuilt>
  builders: Map<string, (op: Operation) => Promise<HostBuilt>>
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
  beforeAdopt?: (next: GroupHandle) => void | Promise<void>
  durablePending?: boolean
  recoveryBinding?: GroupMLSParams['recoveryBinding']
  recovery?: { timeoutMs?: number; deadlineMs?: number; getDelayMs?: () => number }
  onRecovery?: (event: RecoveryEvent) => void | Promise<void>
}

export function makeMember(params: MakeMemberParams): Member {
  const { hub, identity, entrySlot, restartOf } = params
  let handle = params.group
  const hostHooks: Member['hostHooks'] = {}
  const appCursorStore = restartOf?.appCursorStore ?? createMemoryAppCursorStore()
  const stateStore = restartOf?.stateStore ?? createMemoryStateStore()
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
  void stateStore.save(handle)

  const access = simpleHandleAccess({
    handle: getHandle,
    adopt: adoptHandle,
    persist: (next, write) => stateStore.save(next, write),
  })
  const adopt = (next: GroupHandle) => access.replace(next)
  const pending =
    pendingStore == null
      ? undefined
      : {
          persistOpened: async (state: Uint8Array, record: PendingAppFrame) => {
            stateStore.saveOpened(state, handle.ledgerTokens)
            pendingStore.set(record.frame.id, record)
          },
          list: async () => [...pendingStore.values()],
          complete: async (id: string) => {
            pendingStore.delete(id)
          },
        }
  const crypto = createGroupCrypto({ access, pending })
  const mls = createGroupMLS({
    access,
    identity,
    entrySlot,
    recoveryBinding: params.recoveryBinding,
  })

  const control = stateStore.control
  const builders = restartOf?.builders ?? new Map<string, (op: Operation) => Promise<HostBuilt>>()
  const signers = restartOf?.signers ?? new Map([[identity.id, identity]])
  const deliveries = restartOf?.deliveries ?? new Map<string, (welcome: Uint8Array) => void>()
  const build = async (op: Operation): Promise<HostBuilt> => {
    const custom = builders.get(op.id)
    if (custom != null) return custom(op)
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
    const current = handle
    if (body.type === 'invite' && body.material != null) {
      const result = await commitInvite(
        current,
        body.material.bundle.publicPackage,
        body.material.invite,
      )
      committed = result
      bodies = body.material.invite.ledgerEntries
      welcome = { bytes: result.welcomeMessage, recipients: [body.material.invite.recipientDID] }
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
      return buildRevokeProofOperation({
        mls,
        op,
        options: { serializeJournal: hostHooks.serializeJournal ?? encodeJournal },
      })
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
      lineage: 0,
      digest: digestAppliedCommit(committed.commitMessage),
    }
  }
  const connection = hub.connect(identity)
  const appOutbox = restartOf?.appOutbox ?? createMemoryAppOutbox()
  const peer = createGroupPeer<Protocols>({
    appOutboxLimit: 128,
    onRecovery: params.onRecovery,
    recovery: params.recovery,
    hub: connection,
    crypto,
    mls,
    control,
    build,
    anchorStore,
    appCursorStore,
    appOutbox,
    localDID: identity.id,
    protocols: { chat },
    handlers: { chat: params.handlers ?? {} } as never,
    adopt: async (blob, expected, write) => {
      const result = await adoptOperationCandidate(access, blob, expected, write, undefined, {
        resolveLedgerEntries: entrySlot.resolve,
      })
      if (result !== 'installed') return result
      const id = write.changes.putOutcomes?.[0]?.opID
      const obligation = (await control.load()).welcomes.find((row) => row.opID === id)
      if (id != null && obligation != null) deliveries.get(id)?.(obligation.welcome)
      return 'installed'
    },
  })

  return {
    hostHooks,
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
  const saved = member.stateStore.saved()
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
  member.deliveries.set(request.id, deliverWelcome)
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
  builder: (op: Operation) => Promise<HostBuilt>,
): OperationRequest {
  const request = operationRequest('ledger', { tokens: [] })
  member.builders.set(request.id, builder)
  return request
}
export function operationIntent(request: OperationRequest): Operation {
  return { ...request, seq: 1, enqueuedAt: Date.now(), stage: 'intent' }
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

export function createDurableHandleAccess(
  params: Pick<Parameters<typeof simpleHandleAccess>[0], 'handle' | 'adopt'>,
): HandleAccess {
  const store = createMemoryStateStore()
  const access = simpleHandleAccess({ ...params, persist: store.save })
  operationStores.set(access, store)
  return access
}

export function createOperationHost(access: HandleAccess) {
  const store = operationStores.get(access) ?? createMemoryStateStore()
  const builders = new Map<string, () => Promise<HostBuilt>>()
  return {
    builders,
    control: store.control,
    build: async (op: Operation) => {
      const build = builders.get(op.id)
      if (build == null) throw new OperationRejectedError('No host builder')
      return build()
    },
    anchorStore: createMemoryAnchorStore(store.database.anchorStore('state')),
    adopt: (blob: Uint8Array, expected: ExpectedOperationState, write: AdoptionWrite) =>
      adoptOperationCandidate(access, blob, expected, write, store.save),
  }
}

type ExpectedOperationState = {
  epoch: number
  authenticatorBefore: Uint8Array
  lineage: number
}

async function adoptOperationCandidate(
  access: HandleAccess,
  blob: Uint8Array,
  expected: ExpectedOperationState,
  write: AdoptionWrite,
  persist?: StateStore['save'],
  options?: Parameters<typeof restoreGroup>[0]['options'],
): Promise<'installed' | 'noop' | 'moved'> {
  const journal = JSON.parse(new TextDecoder().decode(blob)) as {
    state: Array<number>
    ledger: Array<string>
  }
  const state = decodeClientState(new Uint8Array(journal.state))
  if (state == null) throw new Error('Invalid candidate state')
  const credential = await access.read((handle) => handle.credential)
  const candidate = await restoreGroup({
    state,
    credential,
    ledgerEntries: journal.ledger,
    options,
  })
  const equal = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i])
  let result: 'installed' | 'noop' | 'moved' = 'moved'
  await access.replace(candidate, persist == null ? () => write : undefined, async (current) => {
    if (
      state.groupContext.epoch === current.epoch &&
      equal(state.keySchedule.epochAuthenticator, current.state.keySchedule.epochAuthenticator)
    ) {
      result = 'noop'
      return false
    }
    if (
      Number(current.epoch) !== expected.epoch ||
      expected.lineage !== 0 ||
      !equal(current.state.keySchedule.epochAuthenticator, expected.authenticatorBefore)
    )
      return false
    await current.carryReceiveProgress(candidate)
    await persist?.(candidate, write)
    result = 'installed'
    return true
  })
  return result
}
