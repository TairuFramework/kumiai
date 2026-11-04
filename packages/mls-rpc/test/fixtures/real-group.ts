import { type OwnIdentity, randomIdentity, stringifyToken } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  encodeControlEnvelope,
  exportGroupInfo,
  type GroupHandle,
  joinGroupExternal,
  ledgerEntryDigest,
  processWelcome,
  publishControllerLog,
  removeMember,
  renewLeaf,
  restoreGroup,
  revokeWithProof,
} from '@kumiai/mls'
import type {
  ControlStore,
  GroupKey,
  GroupTransaction,
  HandlerCompletion,
  PendingAppFrames,
} from '@kumiai/rpc'
import { createMemoryControlStore } from '@kumiai/rpc-conformance'
import {
  bytesToBase64,
  createCommit,
  decode,
  defaultProposalTypes,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'

import {
  type ControlHandleAccess,
  type HandleAccess,
  type SimpleHandleAccessParams,
  simpleHandleAccess,
} from '../../src/access.js'
import {
  createGroupMLS,
  createLedgerEntrySlot,
  type GroupMLSDependencies,
  type LedgerEntrySlot,
} from '../../src/mls.js'
import { createTransactionalStore, type TransactionalStore } from './transactional-access.js'

const controls = new WeakMap<ControlHandleAccess, ControlStore>()

export function testGroupMLSDependencies(
  access: ControlHandleAccess,
  control: ControlStore | undefined = controls.get(access),
): GroupMLSDependencies & { access: ControlHandleAccess } {
  if (control === undefined) throw new Error('Missing fixture control store')
  return {
    access,
    control,
    readRecoverySource: () => access.readControl(async ({ source }) => source),
  }
}

export type RealMember = {
  identity: OwnIdentity
  handle: GroupHandle
  slot: LedgerEntrySlot
}

export async function buildRealRotation(handle: GroupHandle): Promise<Uint8Array> {
  const result = await createCommit({
    context: handle.context,
    state: handle.state,
    extraProposals: [],
  })
  return encode(mlsMessageEncoder, result.commit)
}

export async function buildRealUnavailableCommit(group: RealGroup): Promise<Uint8Array> {
  const handle = group.committer.handle
  const member = group.members[0]
  if (member === undefined) throw new Error('missing receiver')
  const result = await createCommit({
    context: handle.context,
    state: {
      ...handle.state,
      unappliedProposals: {
        [bytesToBase64(new Uint8Array(32).fill(8))]: {
          proposal: {
            proposalType: defaultProposalTypes.remove,
            remove: { removed: member.handle.state.privatePath.leafIndex },
          },
          senderLeafIndex: handle.state.privatePath.leafIndex,
        },
      },
    },
    wireAsPublicMessage: true,
    authenticatedData: encodeControlEnvelope({ v: 1 }),
  })
  return encode(mlsMessageEncoder, result.commit)
}

export async function loadLifecyclePipelineFixture() {
  return (await import(
    new URL('../../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
  )) as {
    managementFixture: (kind: 'root' | 'mbr' | 'membership') => Promise<{
      alice: OwnIdentity
      bob: OwnIdentity
      log: Parameters<typeof publishControllerLog>[1]
      creatorBinding: ControllerBinding
      binding: (iat: number) => Promise<ControllerBinding>
      member: { did: string; add: string }
      newcomer: OwnIdentity
      deniedDID: string
      denialAliases: { long: string; short: string }
      nextLog: (
        op: 'log' | 'deny' | 'deny-alias' | 'remove',
      ) => Parameters<typeof publishControllerLog>[1]
      admissionBinding: (
        authority: 'effective' | 'removed' | 'unavailable' | 'foreign',
      ) => Promise<ControllerBinding>
    }>
    lowLevelExternal: (params: {
      group: GroupHandle
      identity: OwnIdentity
      binding: ControllerBinding
      resync: boolean
    }) => Promise<Uint8Array>
    rawAdd: (
      group: GroupHandle,
      identity: OwnIdentity,
      binding: ControllerBinding,
    ) => Promise<{ message: Uint8Array }>
    agent(byte: number): OwnIdentity
    pipelineGroup(): Promise<{ group: GroupHandle; identity: OwnIdentity }>
    timedBinding(params: {
      identity: OwnIdentity
      iat: number
      exp: number
      parent?: string
      issuer?: OwnIdentity
    }): Promise<ControllerBinding>
    lowLevelWelcome(
      group: GroupHandle,
      identity: OwnIdentity,
      binding: ControllerBinding,
    ): Promise<{ author: GroupHandle; joined: GroupHandle }>
  }
}

export async function createRealBoundRecovery(
  makeAccess: (
    member: RealMember,
  ) => Promise<{ access: HandleAccess; control: ControlStore }> = async (member) => {
    const access = persistedTestAccess({
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
    })
    return { access, control: testGroupMLSDependencies(access).control }
  },
  options: { replaceStaleLeaf?: boolean } = {},
  bindingKind: 'root' | 'mbr' | 'membership' = 'root',
) {
  const fixture = await loadLifecyclePipelineFixture()
  const now = Math.floor(Date.now() / 1000)
  const management = await fixture.managementFixture(bindingKind)
  const { alice, bob, creatorBinding } = management
  const cached = options.replaceStaleLeaf
    ? await fixture.timedBinding({
        identity: bob,
        iat: options.replaceStaleLeaf ? now - 5 : now - 20,
        exp: now + 1000,
        ...(options.replaceStaleLeaf ? { parent: creatorBinding.capability, issuer: alice } : {}),
      })
    : await management.binding(now - 20)
  let offered = cached
  let source = (
    await createGroup(alice, 'bound-conformance', {
      controller: creatorBinding,
      controllerLog: management.log,
    })
  ).group
  if (options.replaceStaleLeaf) {
    const staleBundle = await createKeyPackageBundle(bob, {
      controller: await fixture.timedBinding({ identity: bob, iat: now - 10, exp: now + 1000 }),
    })
    const stale = await createInvite({ group: source, identity: alice, recipientDID: bob.id })
    source = (await commitInvite(source, staleBundle.publicPackage, stale.invite)).newGroup
  }
  const bundle = await createKeyPackageBundle(bob, {
    controller: cached,
    controllerLog: management.log,
  })
  const { invite } = await createInvite({ group: source, identity: alice, recipientDID: bob.id })
  const added = await commitInvite(source, bundle.publicPackage, invite)
  source = added.newGroup
  const slot = createLedgerEntrySlot()
  const group = (
    await processWelcome({
      identity: bob,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options: { resolveLedgerEntries: slot.resolve },
    })
  ).group
  const member = { identity: bob, handle: group, slot }
  const { access, control } = await makeAccess(member)
  const requester = createGroupMLS({
    identity: bob,
    ...testGroupMLSDependencies(access, control),
    entrySlot: member.slot,
    recoveryBinding: async () => offered,
  })
  const responder = createGroupMLS({
    identity: alice,
    ...testGroupMLSDependencies(
      testHandleAccess({
        handle: () => source,
        adopt: (next) => {
          source = next
        },
      }),
    ),
    entrySlot: createLedgerEntrySlot(),
  })
  return {
    requesterDID: bob.id,
    denialAliases: management.denialAliases,
    buildRecoveryCommit: async () => ({
      commit: await fixture.lowLevelExternal({
        group: source,
        identity: bob,
        binding: cached,
        resync: source.findMemberLeafIndex(bob.id) != null,
      }),
      context: {},
    }),
    requester,
    responder,
    ratchet: async () => {
      const current = await access.read((handle) => handle)
      await access.replace((await renewLeaf(await bareTestHandle(current), cached)).newGroup)
    },
    replaceBinding: async () => {
      offered = await management.binding(now - 10)
    },
    buildManagementCommit: async (op: 'log' | 'deny' | 'deny-alias' | 'remove') => {
      if (op === 'remove' && bindingKind !== 'root') {
        // Preserve a root-bound peer leaf so recovery reaches candidate validation after removal.
        const current = await access.read((handle) => handle)
        const renewed = await renewLeaf(
          await bareTestHandle(current),
          await fixture.timedBinding({
            identity: bob,
            iat: now - 10,
            exp: now + 1000,
          }),
        )
        const entries = renewed.newGroup.ledgerTokens.slice(current.ledgerTokens.length)
        const applied = await responder.processCommit(renewed.commitMessage, {
          senderDID: bob.id,
          resolveLedgerEntries: async () => entries,
        })
        if (!applied.advanced) throw new Error('Root-bound requester leaf was not installed')
      }
      const log = management.nextLog(op)
      const author = await bareTestHandle(source)
      const result =
        op === 'log'
          ? await publishControllerLog(author, log)
          : await revokeWithProof(author, {
              log,
              ...(op === 'deny' || op === 'deny-alias'
                ? { deny: [management.deniedDID] }
                : { remove: [management.member] }),
            }).then((built) => {
              if (built.status !== 'built') throw new Error(`No management commit: ${built.status}`)
              return built.result
            })
      if (result == null) throw new Error('Missing log commit')
      const entries = result.newGroup.ledgerTokens.slice(source.ledgerTokens.length)
      source = result.newGroup
      return {
        commit: result.commitMessage,
        entries,
        context: {
          senderDID: alice.id,
          resolveLedgerEntries: async () => entries,
        },
      }
    },
    buildAdmission: async (authority: 'effective' | 'removed' | 'unavailable' | 'foreign') => ({
      commit: (
        await fixture.rawAdd(
          source,
          management.newcomer,
          await management.admissionBinding(authority),
        )
      ).message,
      context: { senderDID: alice.id },
    }),
  }
}

/**
 * A real MLS group with a COMMITTER outside the member list.
 *
 * Every commit the conformance suites hand a port is authored here rather than by one of the
 * ports under test, which is what makes them all RECEIVED commits — the case `processCommit`'s
 * contract is about, and the case a double that models a commit as a value to adopt gets wrong.
 */
export type RealGroup = {
  committer: RealMember
  members: Array<RealMember>
  /** Every ledger-entry body any commit in this group names, by digest. */
  bodies: Map<string, string>
  /** What a `CommitContext` carries: the bodies riding a commit's own frame. */
  resolveLedgerEntries: (ids: Array<string>) => Promise<Array<string>>
}

export async function createRealGroup(
  size: number,
  groupID: string,
  identities: Array<OwnIdentity> = [],
): Promise<RealGroup> {
  // Port conformance witnesses retain several epochs across successive adoptions.
  const keyRetention = { retainKeysForEpochs: 4 }
  const bodies = new Map<string, string>()
  const resolveLedgerEntries = async (ids: Array<string>) =>
    ids.map((id) => {
      const token = bodies.get(id)
      if (token == null) throw new Error(`unknown ledger entry ${id}`)
      return token
    })

  const makeSlot = (): LedgerEntrySlot => {
    const slot = createLedgerEntrySlot()
    // Installed so joining and restoring resolve; `processCommit` swaps in the commit's own
    // resolver for its duration and clears it again, which is the contract this slot exists for.
    slot.install(resolveLedgerEntries)
    return slot
  }

  const committerIdentity = randomIdentity()
  const committerSlot = makeSlot()
  const { group } = await createGroup(committerIdentity, groupID, {
    resolveLedgerEntries: committerSlot.resolve,
    keyRetention,
  })
  const committer: RealMember = {
    identity: committerIdentity,
    handle: group,
    slot: committerSlot,
  }

  const members: Array<RealMember> = []
  for (let index = 0; index < size; index++) {
    const identity = identities[index] ?? randomIdentity()
    const slot = makeSlot()
    const { invite } = await createInvite({
      group: committer.handle,
      identity: committerIdentity,
      recipientDID: identity.id,
      permission: 'member',
    })
    for (const token of invite.ledgerEntries) bodies.set(ledgerEntryDigest(token), token)
    const bundle = await createKeyPackageBundle(identity)
    const added = await commitInvite(committer.handle, bundle.publicPackage, invite)
    committer.handle = added.newGroup
    // The members already in the group walk forward over the same commit the newcomer's
    // Welcome describes, so the whole group ends at one epoch.
    for (const member of members) await member.handle.processMessage(added.commitMessage)
    const { group: joined } = await processWelcome({
      identity,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      ratchetTree: committer.handle.state.ratchetTree,
      options: { resolveLedgerEntries: slot.resolve, keyRetention },
    })
    members.push({ identity, handle: joined, slot })
  }

  return { committer, members, bodies, resolveLedgerEntries }
}

/** A Commit the committer authors and adopts, framed at the epoch every member is still at. */
export async function buildRealCommit(
  group: RealGroup,
  options: { removes?: number } = {},
): Promise<Uint8Array> {
  group.committer.handle = await bareTestHandle(group.committer.handle)
  if (options.removes != null) {
    const member = group.members[options.removes]
    if (member == null) throw new Error(`no member at index ${options.removes}`)
    const leafIndex = group.committer.handle.findMemberLeafIndex(member.identity.id)
    if (leafIndex == null) throw new Error(`no leaf for ${member.identity.id}`)
    const removed = await removeMember(group.committer.handle, leafIndex)
    group.committer.handle = removed.newGroup
    return removed.commitMessage
  }
  // A plain advance. MLS has no bare "move on" commit reachable from this surface, so the
  // committer adds a throwaway member — a commit that changes the epoch and carries entries,
  // which is also the shape a receiving port has to resolve bodies for.
  const newcomer = randomIdentity()
  const { invite } = await createInvite({
    group: group.committer.handle,
    identity: group.committer.identity,
    recipientDID: newcomer.id,
    permission: 'member',
  })
  for (const token of invite.ledgerEntries) group.bodies.set(ledgerEntryDigest(token), token)
  const bundle = await createKeyPackageBundle(newcomer)
  const added = await commitInvite(group.committer.handle, bundle.publicPackage, invite)
  group.committer.handle = added.newGroup
  return added.commitMessage
}

/**
 * A genuine external commit — `members[rejoining]` rejoining the group it is already in — and the
 * forgery of it a publisher holding no key can produce: the same frame with ONLY the UpdatePath
 * leaf's credential identity rewritten. The leaf's signature key is untouched, so the frame is
 * still a well-formed external commit at the same epoch whose signature no longer matches its
 * content.
 */
export async function buildRealExternalCommit(
  group: RealGroup,
  params: { rejoining: number; forgeAs: string },
): Promise<{ genuine: Uint8Array; forged: Uint8Array }> {
  const member = group.members[params.rejoining]
  if (member == null) throw new Error(`no member at index ${params.rejoining}`)
  const { groupInfo } = await exportGroupInfo({ group: group.committer.handle })
  const { commitMessage } = await joinGroupExternal({
    identity: member.identity,
    groupInfo,
    credential: member.handle.credential,
    resync: true,
  })
  return {
    genuine: commitMessage,
    forged: rewriteExternalCommitIdentity(commitMessage, params.forgeAs),
  }
}

function rewriteExternalCommitIdentity(commit: Uint8Array, did: string): Uint8Array {
  const decoded = decode(mlsMessageDecoder, commit)
  if (decoded == null || decoded.wireformat !== wireformats.mls_public_message) {
    throw new Error('not a public message')
  }
  const content = decoded.publicMessage.content as unknown as {
    commit: { path: { leafNode: { credential: { identity: Uint8Array } } } }
  }
  const path = content.commit.path
  return encode(mlsMessageEncoder, {
    ...decoded,
    publicMessage: {
      ...decoded.publicMessage,
      content: {
        ...content,
        commit: {
          ...content.commit,
          path: {
            ...path,
            leafNode: {
              ...path.leafNode,
              credential: {
                ...path.leafNode.credential,
                identity: new TextEncoder().encode(JSON.stringify({ id: did })),
              },
            },
          },
        },
      },
    },
  } as never)
}

/** Seal a signed payload without the port's author-side shape guard. */
export async function sealRealRecoveryVerdict(
  member: RealMember,
  request: Uint8Array,
  verdict: Record<string, unknown>,
): Promise<Uint8Array> {
  const { sealToRequest } = await import(
    new URL('../../../mls/src/recovery.ts', import.meta.url).href
  )
  const token = await member.identity.signToken(
    { ...verdict, type: 'kumiai.recovery-verdict' },
    { embedLongForm: true },
  )
  return await sealToRequest({
    kind: {
      hpkeInfo: new TextEncoder().encode('kumiai/mls/recovery-verdict/v1'),
      aadDomain: new TextEncoder().encode('kumiai/mls/recovery-verdict-aad/v1'),
      version: 1,
      fail: (_reason: unknown, message: string) => new Error(message),
    },
    group: member.handle,
    request: new TextDecoder().decode(request),
    plaintext: new TextEncoder().encode(stringifyToken(token)),
    requireMember: false,
  })
}

export function persistedTestAccess(
  params: Pick<Parameters<typeof simpleHandleAccess>[0], 'handle' | 'adopt'>,
  store: TransactionalStore = createTransactionalStore(params.handle()),
): HandleAccess {
  const access = simpleHandleAccess({
    key: { groupID: params.handle().groupID, incarnation: 1 },
    ...params,
    stateVersion: () => store.snapshot().revision,
    persist: (handle, write) =>
      store.save(
        store.snapshot().revision,
        encodeClientState(handle.state),
        handle.ledgerTokens,
        undefined,
        write,
      ),
  })
  controls.set(access, store.control)
  return access
}

export function testHandleAccess(
  params: Omit<SimpleHandleAccessParams, 'stateVersion' | 'key'> & {
    key?: SimpleHandleAccessParams['key']
    stateVersion?: SimpleHandleAccessParams['stateVersion']
  },
): HandleAccess {
  let version = 0
  let state = params.handle().state
  const access = simpleHandleAccess({
    key: { groupID: params.handle().groupID, incarnation: 1 },
    ...params,
    stateVersion:
      params.stateVersion ??
      (() => {
        const current = params.handle().state
        if (params.persist == null && current !== state) {
          state = current
          version += 1
        }
        return version
      }),
    persist:
      params.persist == null
        ? undefined
        : async (handle, write) => {
            await params.persist?.(handle, write)
            version += 1
          },
  })
  controls.set(
    access,
    createMemoryControlStore(params.key ?? { groupID: params.handle().groupID, incarnation: 1 }),
  )
  return access
}

/** Bare test authors restore raw keys independently of the access under test. */
export async function bareTestHandle(handle: GroupHandle): Promise<GroupHandle> {
  const state = decodeClientState(encodeClientState(handle.state))
  if (state === undefined) throw new Error('Invalid test state')
  return restoreGroup({
    state,
    credential: handle.credential,
    ledgerEntries: handle.ledgerTokens,
    options: {
      cryptoProvider: { getCiphersuiteImpl: async () => handle.context.cipherSuite },
      keyRetention: handle.context.clientConfig?.keyRetentionConfig,
      commitPolicy: handle.commitPolicy,
      resolveLedgerEntries: handle.resolveLedgerEntries,
      onLedgerEntries: handle.onLedgerEntries,
    },
  })
}

export function createTestCompletion(
  key: GroupKey,
  pending?: PendingAppFrames,
): HandlerCompletion<GroupTransaction> {
  return {
    key,
    async complete(ids) {
      if (pending === undefined && ids.length !== 0) throw new Error('No pending frame store')
      for (const id of ids) await pending?.complete(id)
    },
    async transact() {
      throw new Error('Transactional completion requires a persistence fixture')
    },
  }
}
