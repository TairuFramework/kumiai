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
  buildRevokeProofOnHandle,
  buildRevokeProofOperation,
  createControlAdoptionPort,
  createControlBuildPort,
  createControlValidationPort,
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
  PendingAppFrame,
  RecoveryEvent,
  WelcomeObligation,
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
): StateStore {
  const database = createMemoryHostDatabase({
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
  build: (op: Operation, group?: GroupHandle) => Promise<HostBuilt>
  prepareBuild: ControlBuildPort['prepareBuild']
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
  deliverWelcome?: (obligation: WelcomeObligation) => Promise<void>
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
  const stateStore =
    restartOf?.stateStore ?? createMemoryStateStore({ groupID: handle.groupID, incarnation: 1 })
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
    access,
    identity,
    entrySlot,
    recoveryBinding: params.recoveryBinding,
  })

  const control = stateStore.control
  const builders = restartOf?.builders ?? new Map<string, (op: Operation) => Promise<HostBuilt>>()
  const signers = restartOf?.signers ?? new Map([[identity.id, identity]])
  const deliveries = new Map<string, (welcome: Uint8Array) => void>()
  const build = async (op: Operation, supplied?: GroupHandle): Promise<HostBuilt> => {
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
    const current = supplied ?? handle
    if (body.type === 'invite' && body.material != null) {
      const result = await commitInvite(
        current,
        body.material.bundle.publicPackage,
        body.material.invite,
      )
      committed = result
      bodies = body.material.invite.ledgerEntries
      welcome = {
        bytes: encodeOperationBody({
          welcome: result.welcomeMessage,
          invite: body.material.invite,
          ratchetTree: result.newGroup.state.ratchetTree,
        }),
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
        ? buildRevokeProofOperation({ mls, op, options })
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
    access,
    control,
    build,
    saveBuilt: (intent, built, expected, mutationID) =>
      stateStore.database.saveBuilt('state', control.key, intent, built, expected, mutationID),
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
  const peer = createGroupPeer<Protocols>({
    appOutboxLimit: 128,
    onRecovery: params.onRecovery,
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
    adopt: adoption.adopt,
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
  builder: (op: Operation) => Promise<HostBuilt>,
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

export async function createDurableHandleAccess(
  params: Pick<Parameters<typeof simpleHandleAccess>[0], 'handle' | 'adopt'>,
): Promise<HandleAccess> {
  const store = createMemoryStateStore({ groupID: params.handle().groupID, incarnation: 1 })
  await store.save(params.handle())
  const access = simpleHandleAccess({
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
  const builders = new Map<string, () => Promise<HostBuilt>>()
  const build = async (op: Operation) => {
    const builder = builders.get(op.id)
    if (builder === undefined) throw new OperationRejectedError('No host builder')
    return builder()
  }
  const restoreCandidate = candidateRestorer(access)
  const control = store.control
  const buildPort = createControlBuildPort({
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
    const saved = decodeStoredState(candidate)
    const state = decodeClientState(saved.state)
    if (state == null) throw new Error('Invalid candidate state')
    const credential = await access.read((handle) => handle.credential)
    return restoreGroup({ state, credential, ledgerEntries: saved.ledger, options })
  }
}
