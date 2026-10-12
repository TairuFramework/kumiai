import { getSignatureInfo, normalizeDID } from '@kokuin/token'
import {
  buildGroupAnchorExtension,
  type ClientState,
  decodeClientState,
  decodeGroupAnchor,
  encodeClientState,
  GROUP_ANCHOR_EXTENSION_TYPE,
  GroupHandle,
  type GroupHandleParams,
  type GroupMember,
  type GroupOptions,
  type LeafBinding,
  type MemberCredential,
  parseMLSCredentialIdentity,
  restoreGroup,
  type SendAdmission,
} from '@kumiai/mls'
import {
  type ControlValidationPort,
  decodeCommitFrame,
  decodeHandshakeFrame,
  decodeLedgerEntries,
  type GroupMLS,
  type HostBuilt,
  type Operation,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import type { EpochReceiverData } from 'ts-mls'

import { decodeControlJournal } from '../../src/control-journal.js'
import { ENTRY_SEAL_LABEL, openEntries } from '../../src/crypto.js'
import { decodeStoredValue, encodeStoredValue } from '../../src/persistence-codec.js'

type MemoryMLS = GroupMLS & {
  memberSlots(): Array<[number, string]>
  setReceiveState(state: Uint8Array): void
  setReceiveHistory(history: Array<[number, { identity: string; state: Uint8Array }]>): void
  receiveHistory(): Array<[number, { identity: string; state: Uint8Array }]>
  carryReceiveProgress(candidate: MemoryMLS): void
  epoch(): number
  authenticator(): Uint8Array
  serializeState(): Uint8Array
  restoreState(bytes: Uint8Array): void
  buildCommit(
    tokens?: Array<string>,
    options?: { adds?: Array<string>; removes?: Array<string> },
  ): Uint8Array
  adopt(commit: Uint8Array): void
}

const { createMemoryGroupMLS } = (await import(
  new URL('../../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  createMemoryGroupMLS(params: {
    groupID: string
    localDID?: string
    epoch: number
    recoverySecret: Uint8Array
    members?: Array<string>
    memberSlots?: Array<[number, string]>
    retainKeysForEpochs?: number
  }): MemoryMLS
}
const { fakeEpochSecret } = (await import(
  new URL('../../../rpc/test/fixtures/fake-crypto.ts', import.meta.url).href
)) as {
  fakeEpochSecret(epoch: number, label: string, length: number, secret: Uint8Array): Uint8Array
}

function model(
  state: ClientState,
  credential: MemberCredential,
  restore = true,
  receiver = false,
  options: GroupOptions = {},
): MemoryMLS {
  const mls = createMemoryGroupMLS({
    groupID: credential.groupID,
    ...(receiver ? {} : { localDID: credential.id }),
    epoch: Number(state.groupContext.epoch),
    recoverySecret: state.keySchedule.exporterSecret,
    memberSlots: state.ratchetTree.flatMap((node, index) => {
      if (node?.nodeType !== 1 || !('identity' in node.leaf.credential)) return []
      return [[index / 2, parseMLSCredentialIdentity(node.leaf.credential.identity).id]]
    }),
    retainKeysForEpochs: options.keyRetention?.retainKeysForEpochs,
  })
  if (restore) mls.restoreState(state.confirmationTag)
  return mls
}

function envelope(state: ClientState, mls: MemoryMLS): ClientState {
  const leaves = new Map(
    state.ratchetTree.flatMap((node) => {
      if (node?.nodeType !== 1 || !('identity' in node.leaf.credential)) return []
      return [[normalizeDID(parseMLSCredentialIdentity(node.leaf.credential.identity).id), node]]
    }),
  )
  const template = leaves.values().next().value
  const anchorData = state.groupContext.extensions.find(
    (extension) => extension.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
  )?.extensionData
  const anchor = anchorData instanceof Uint8Array ? decodeGroupAnchor(anchorData) : null
  const slots = mls.memberSlots()
  const tree: ClientState['ratchetTree'] = Array.from({
    length: Math.max(state.ratchetTree.length, ...slots.map(([index]) => index * 2 + 1)),
  })
  for (const [index, did] of slots) {
    const held = leaves.get(normalizeDID(did))
    if (held !== undefined) tree[index * 2] = structuredClone(held)
    else {
      // Only floating did:key leaves are synthesised in this independent wire model.
      if (anchor?.controller != null) throw new Error('Floating leaf refused in lifecycle group')
      if (template === undefined) throw new Error('Missing model leaf template')
      const [algorithm, publicKey] = getSignatureInfo(did)
      if (algorithm !== 'EdDSA') throw new Error('Unsupported model leaf key')
      tree[index * 2] = {
        nodeType: 1,
        leaf: {
          ...structuredClone(template.leaf),
          credential: {
            credentialType: 1,
            identity: new TextEncoder().encode(JSON.stringify({ v: 1, id: did })),
          },
          signaturePublicKey: publicKey,
        },
      }
    }
  }
  const changingEpoch = state.groupContext.epoch !== BigInt(mls.epoch())
  return {
    ...state,
    ratchetTree: tree,
    groupContext: { ...state.groupContext, epoch: BigInt(mls.epoch()) },
    keySchedule: {
      ...state.keySchedule,
      epochAuthenticator: mls.authenticator(),
      resumptionPsk: mls.authenticator(),
    },
    ...(changingEpoch
      ? {
          secretTree: {
            leafWidth: Math.max(1, ...slots.map(([index]) => index + 1)),
            intermediateNodes: { 0: sha256(mls.authenticator()) },
            leafNodes: {},
          },
        }
      : {}),
    historicalReceiverData: new Map(
      mls
        .receiveHistory()
        .map(([epoch, held]) => [
          BigInt(epoch),
          decodeStoredValue(held.state) as EpochReceiverData,
        ]),
    ),
    // The v2 storage envelope retains the independent double's entire durable state.
    confirmationTag: mls.serializeState(),
  }
}

export function seedMemoryControlState(state: ClientState, credential: MemberCredential) {
  const seeded = structuredClone(state)
  if (
    !seeded.groupContext.extensions.some(
      (extension) => extension.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
    )
  )
    seeded.groupContext.extensions.push(
      buildGroupAnchorExtension({ creatorDID: credential.id, version: 1 }),
    )
  const mls = model(seeded, credential, false)
  captureReceiveState(seeded, mls)
  return envelope(seeded, mls)
}

const models = new WeakMap<GroupHandle, MemoryMLS>()

export function memoryModel(handle: GroupHandle): MemoryMLS {
  const mls = models.get(handle)
  if (mls === undefined) throw new Error('Not an independent memory handle')
  return mls
}

function captureReceiveState(state: ClientState, mls: MemoryMLS): void {
  mls.setReceiveHistory(
    [...state.historicalReceiverData].map(([at, held]) => [
      Number(at),
      {
        identity: toB64U(held.resumptionPsk),
        state: encodeStoredValue(held),
      },
    ]),
  )
  mls.setReceiveState(
    encodeStoredValue({
      resumptionPsk: mls.authenticator(),
      secretTree: state.secretTree,
      ratchetTree: state.ratchetTree,
      senderDataSecret: state.keySchedule.senderDataSecret,
      groupContext: state.groupContext,
    }),
  )
}

function exportedSecret(
  state: ClientState,
  mls: MemoryMLS,
  label: string,
  context: Uint8Array,
  length: number,
): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0 || length > 8160)
    throw new Error('Invalid exporter length')
  return fakeEpochSecret(
    mls.epoch(),
    JSON.stringify([label, toB64U(context), toB64U(mls.authenticator())]),
    length,
    state.keySchedule.exporterSecret,
  )
}

class MemoryControlHandle extends GroupHandle {
  #mls: MemoryMLS
  #view: ClientState

  constructor(params: GroupHandleParams & { model: MemoryMLS }) {
    super(params)
    this.#mls = params.model
    this.#view = params.state
    models.set(this, params.model)
  }

  override get state(): ClientState {
    // The superclass reads the anchor before subclass private fields exist.
    if (!models.has(this)) return super.state
    if (this.#view.groupContext.epoch !== BigInt(this.#mls.epoch()))
      Object.assign(this.#view, envelope(this.#view, this.#mls))
    // Keep the live progress buffers visible; only the durable model snapshot is copied.
    captureReceiveState(this.#view, this.#mls)
    this.#view.confirmationTag = this.#mls.serializeState()
    return this.#view
  }

  override get epoch(): bigint {
    return models.has(this) ? BigInt(this.#mls.epoch()) : super.epoch
  }

  override get memberCount(): number {
    if (models.has(this)) this.state
    return super.memberCount
  }

  override listMembers(): Array<GroupMember> {
    this.state
    return super.listMembers()
  }

  override findMemberLeafIndex(did: string): number | undefined {
    this.state
    return super.findMemberLeafIndex(did)
  }

  override findMemberLongForm(did: string): string | undefined {
    this.state
    return super.findMemberLongForm(did)
  }

  override bindingOfDID(did: string): LeafBinding | undefined {
    this.state
    return super.bindingOfDID(did)
  }

  override sendAdmission(): SendAdmission {
    return { ...super.sendAdmission(), epoch: Number(this.epoch) }
  }

  override async exportSecret(
    label: string,
    context: Uint8Array,
    length = 32,
  ): Promise<Uint8Array> {
    return exportedSecret(this.#view, this.#mls, label, context, length)
  }

  override async carryReceiveProgress(candidate: GroupHandle): Promise<void> {
    if (!(candidate instanceof MemoryControlHandle))
      throw new Error('Not an independent memory candidate')
    captureReceiveState(this.#view, this.#mls)
    captureReceiveState(candidate.#view, candidate.#mls)
    this.#mls.carryReceiveProgress(candidate.#mls)
    candidate.#view.historicalReceiverData = envelope(
      candidate.#view,
      candidate.#mls,
    ).historicalReceiverData
    candidate.#view.confirmationTag = candidate.#mls.serializeState()
  }
}

export async function restoreMemoryControlHandle(params: {
  state: ClientState
  credential: MemberCredential
  ledgerEntries: Array<string>
  options?: GroupOptions
}): Promise<GroupHandle> {
  const { credential, ledgerEntries, options = {} } = params
  const state = structuredClone(params.state)
  const ownLeaf = state.ratchetTree[state.privatePath.leafIndex * 2]
  if (
    new TextDecoder().decode(state.groupContext.groupId) !== credential.groupID ||
    (state.groupActiveState.kind !== 'removedFromGroup' &&
      (ownLeaf?.nodeType !== 1 ||
        !('identity' in ownLeaf.leaf.credential) ||
        parseMLSCredentialIdentity(ownLeaf.leaf.credential.identity).id !== credential.id))
  )
    throw new Error('Memory handle owner or group mismatch')
  const mls = model(state, credential, true, false, options)
  if (
    BigInt(mls.epoch()) !== state.groupContext.epoch ||
    toB64U(mls.authenticator()) !== toB64U(state.keySchedule.epochAuthenticator)
  )
    throw new Error('Memory state identity mismatch')
  // Reuse only context construction and signed ledger folding, never MLS transitions.
  const restored = await restoreGroup({
    state,
    credential: { ...credential },
    ledgerEntries,
    options,
  })
  if (restored.ledgerTokens.length !== ledgerEntries.length)
    throw new Error('Invalid memory ledger')
  return new MemoryControlHandle({
    state,
    credential: restored.credential,
    context: restored.context,
    ledger: restored.ledger,
    commitPolicy: options.commitPolicy,
    resolveLedgerEntries: options.resolveLedgerEntries,
    onLedgerEntries: options.onLedgerEntries,
    model: mls,
  })
}

export async function buildSealedMemoryOperation(
  op: Operation,
  handle: GroupHandle,
): Promise<HostBuilt> {
  const sourceState = handle.state
  const mls = memoryModel(handle)
  const before = mls.serializeState()
  const epoch = mls.epoch()
  const authenticatorBefore = mls.authenticator()
  const { target } = decodeStoredValue(op.body) as { target: string }
  const commit = mls.buildCommit([], { adds: [target] })
  let candidate: Uint8Array
  try {
    mls.adopt(commit)
    candidate = encodeClientState(envelope(sourceState, mls))
  } finally {
    mls.restoreState(before)
  }
  return {
    commit,
    bodies: [],
    journal: candidate,
    welcome: { bytes: new TextEncoder().encode(target), recipients: [target] },
    incarnation: 1,
    epoch,
    authenticatorBefore,
    digest: toB64U(sha256(commit)),
  }
}

export function sealedMemoryValidation(): ControlValidationPort {
  return {
    async restoreValidation(built) {
      const journal = decodeControlJournal(built.journal)
      const state = decodeClientState(journal.sourceState)
      const identity = journal.source.identity
      if (
        state === undefined ||
        identity === null ||
        journal.checkpoint !== built.searchFrom ||
        built.epoch !== identity.epoch ||
        built.incarnation !== identity.incarnation ||
        toB64U(built.authenticatorBefore) !== toB64U(identity.authenticator) ||
        toB64U(sha256(built.payload)) !== built.payloadDigest
      )
        return null
      const source = () => model(state, journal.sourceCredential, true, true)
      const check = async (payload: Uint8Array) => {
        const { commit, sealedEntries } = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
        const working = source()
        const result = await working.processCommit(commit, {
          resolveLedgerEntries: async () =>
            decodeLedgerEntries(
              openEntries(
                exportedSecret(state, working, ENTRY_SEAL_LABEL, new Uint8Array(), 32),
                sealedEntries,
              ),
            ),
        })
        return { working, result, header: await source().readCommitHeader(commit) }
      }
      return {
        source: journal.source,
        readCommitHeader: (commit) => source().readCommitHeader(commit),
        verifyOwn: async (value) => {
          if (toB64U(value.payload) !== toB64U(built.payload)) return false
          const candidate = decodeClientState(journal.candidate)
          if (candidate === undefined) return false
          const checked = await check(value.payload)
          return (
            checked.result.applied &&
            checked.header?.external !== true &&
            checked.header?.committerDID === journal.sourceCredential.id &&
            checked.working.epoch() === Number(candidate.groupContext.epoch) &&
            toB64U(checked.working.authenticator()) ===
              toB64U(candidate.keySchedule.epochAuthenticator)
          )
        },
        validateFrame: async (frame) => {
          try {
            const { result, header } = await check(frame.payload)
            if (result.validation === 'unavailable')
              return { kind: 'unavailable', reason: 'missing-proposal' }
            if (!result.applied || header === null) return { kind: 'invalid', reason: 'policy' }
            return {
              kind: 'valid',
              header,
              advanced: result.advanced,
              removed: false,
              own: header.external !== true && header.committerDID === journal.sourceCredential.id,
            }
          } catch {
            return { kind: 'unavailable', reason: 'resolver' }
          }
        },
      }
    },
  }
}
