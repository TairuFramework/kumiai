import { getSignatureInfo, normalizeDID } from '@kokuin/token'
import {
  authorPrivateCommit,
  buildGroupAnchorExtension,
  buildLedgerHeadExtension,
  type ClientState,
  computeHead,
  controllerOf,
  DEVICE_ENTRY_TYPE,
  type DeviceValue,
  decodeClientState,
  decodeGroupAnchor,
  encodeClientState,
  foldEnvelope,
  GROUP_ANCHOR_EXTENSION_TYPE,
  GroupHandle,
  type GroupHandleParams,
  type GroupMember,
  type GroupOptions,
  GroupRestoreError as InvalidCandidateError,
  LEDGER_HEAD_EXTENSION_TYPE,
  type LeafBinding,
  LeafLapsedError,
  ledgerEntryDigest,
  type MemberCredential,
  parseMLSCredentialIdentity,
  readLedgerHead,
  restoreGroup,
  restrictCommitAuthoring,
  type SendAdmission,
  type VerifiedLedgerEntry,
  verifyLedgerEntry,
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
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64U, toB64U } from '@sozai/codec'
import {
  contentTypes,
  decode,
  defaultKeyRetentionConfig,
  type EpochReceiverData,
  encode,
  type GenerationSecret,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type PrivateMessage,
  protocolVersions,
  type SecretTree,
  wireformats,
} from 'ts-mls'

import { decodeControlJournal } from '../../src/control-journal.js'
import { ENTRY_SEAL_LABEL, openEntries } from '../../src/crypto.js'
import { decodeStoredValue, encodeStoredValue } from '../../src/persistence-codec.js'

type MemoryMLS = GroupMLS & {
  ledgerTokens(): Array<string>
  authenticatedLedgerHead(): string
  applyLedgerEntries(tokens: Array<string>): Promise<void>
  bootstrapLedger(tokens: Array<string>, persist?: () => Promise<void> | void): Promise<void>
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
  adopt(commit: Uint8Array): void | Promise<void>
}

const { createMemoryGroupMLS, memoryCheckpointFrame } = (await import(
  new URL('../../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  memoryCheckpointFrame(body: Record<string, unknown>, secret: Uint8Array): Uint8Array
  createMemoryGroupMLS(params: {
    groupID: string
    localDID?: string
    epoch: number
    recoverySecret: Uint8Array
    members?: Array<string>
    memberSlots?: Array<[number, string]>
    retainKeysForEpochs?: number
    ledgerEntries?: Array<string>
    entryDigest: typeof ledgerEntryDigest
    computeLedgerHead(ids: Array<string>): string
    validateLedgerEntries(tokens: Array<string>, previous: Array<string> | null): Promise<void>
  }): MemoryMLS
}
const { verifyDeviceEntry } = (await import(
  new URL('../../../mls/src/device-proof.ts', import.meta.url).href
)) as {
  verifyDeviceEntry(
    entry: VerifiedLedgerEntry<DeviceValue>,
    context: {
      bindingOfDID(did: string): LeafBinding | undefined
      controllerOf(did: string): string | undefined
    },
  ): Promise<boolean>
}
const { assertSenderNotLapsed } = (await import(
  new URL('../../../mls/src/lifecycle.ts', import.meta.url).href
)) as {
  assertSenderNotLapsed(params: {
    group: GroupHandle
    tree: ClientState['ratchetTree']
    leafIndex: number
    extensions: ClientState['groupContext']['extensions']
  }): void
}
const { mutexFor } = (await import(
  new URL('../../../mls/src/group-handle.ts', import.meta.url).href
)) as { mutexFor(handle: GroupHandle): { run<T>(fn: () => Promise<T>): Promise<T> } }
const { fakeEpochSecret } = (await import(
  new URL('../../../rpc/test/fixtures/fake-crypto.ts', import.meta.url).href
)) as {
  fakeEpochSecret(epoch: number, label: string, length: number, secret: Uint8Array): Uint8Array
}

const verifiedLedgers = new WeakMap<MemoryMLS, Map<string, VerifiedLedgerEntry>>()

function model(
  state: ClientState,
  credential: MemberCredential,
  restore = true,
  receiver = false,
  options: GroupOptions = {},
  ledgerEntries: Array<string> = [],
): MemoryMLS {
  const verified = new Map<string, VerifiedLedgerEntry>()
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
    ledgerEntries,
    entryDigest: ledgerEntryDigest,
    computeLedgerHead: (ids) => toB64U(computeHead(credential.groupID, ids)),
    validateLedgerEntries: async (tokens, previous) => {
      const entries = await Promise.all(
        tokens.map(async (token) => {
          const entry = await verifyLedgerEntry(token)
          if (entry === null || entry.entry.groupID !== credential.groupID)
            throw new InvalidCandidateError('Invalid memory ledger')
          return { token, entryID: ledgerEntryDigest(token), verified: entry }
        }),
      )
      if (previous !== null) {
        const base = restrictCommitAuthoring(
          await restoreGroup({
            state: envelope(state, mls),
            credential,
            ledgerEntries: previous,
            options,
          }),
        )
        const result = foldEnvelope({
          entries,
          baseRoster: base.roster,
          baseRegistry: base.registry,
          groupID: credential.groupID,
          context:
            base.anchor.controller == null
              ? undefined
              : {
                  controllerID: base.anchor.controller,
                  memberController: (did) => base.bindingOfDID(did)?.controller,
                },
        })
        if (!result.ok) throw new Error(`Invalid memory enactment: ${result.reason}`)
        for (const { verified: entry } of entries) {
          if (entry.entry.type !== DEVICE_ENTRY_TYPE) continue
          if (base.anchor.controller != null && (entry.entry.value as DeviceValue).op !== 'beacon')
            continue
          if (
            !(await verifyDeviceEntry(entry as VerifiedLedgerEntry<DeviceValue>, {
              bindingOfDID: (did) => base.bindingOfDID(did),
              controllerOf: (did) => controllerOf(base.registry, did),
            }))
          )
            throw new Error('Invalid memory device proof')
        }
      }
      for (const entry of entries) verified.set(entry.token, entry.verified)
    },
  })
  verifiedLedgers.set(mls, verified)
  if (restore) {
    try {
      const snapshot = JSON.parse(new TextDecoder().decode(state.confirmationTag))
      const canonical = decodeClientState(encodeClientState(state))
      if (canonical === undefined) throw new Error('Invalid memory receive state')
      mls.restoreState(
        new TextEncoder().encode(
          JSON.stringify({
            ...snapshot,
            receiveState: toB64U(encodeStoredValue(receiverData(canonical))),
            receiveHistory: [...canonical.historicalReceiverData].map(([epoch, held]) => [
              Number(epoch),
              { identity: toB64U(held.resumptionPsk), state: toB64U(encodeStoredValue(held)) },
            ]),
          }),
        ),
      )
    } catch (cause) {
      throw new InvalidCandidateError(
        cause instanceof Error ? cause.message : 'Invalid memory state',
        {
          cause,
        },
      )
    }
  }
  return mls
}

function serializeModel(mls: MemoryMLS): Uint8Array {
  const snapshot = JSON.parse(new TextDecoder().decode(mls.serializeState()))
  // Receive secrets belong only to the envelope, outside the control projection.
  delete snapshot.receiveState
  delete snapshot.receiveHistory
  return new TextEncoder().encode(JSON.stringify(snapshot))
}

function freshSecretTree(mls: MemoryMLS): SecretTree {
  const slots = mls.memberSlots()
  const leafNodes: SecretTree['leafNodes'] = {}
  for (const [index] of slots) {
    const ratchet = (kind: string): GenerationSecret => ({
      secret: fakeEpochSecret(mls.epoch(), `${kind}:${index}`, 32, mls.authenticator()),
      generation: 0,
      unusedGenerations: {},
    })
    leafNodes[index * 2] = { handshake: ratchet('handshake'), application: ratchet('app') }
  }
  return {
    leafWidth: Math.max(1, ...slots.map(([index]) => index + 1)),
    intermediateNodes: {},
    leafNodes,
  }
}

function receiverData(state: ClientState): EpochReceiverData {
  return {
    resumptionPsk: state.keySchedule.resumptionPsk,
    secretTree: state.secretTree,
    ratchetTree: state.ratchetTree,
    senderDataSecret: state.keySchedule.senderDataSecret,
    groupContext: state.groupContext,
  }
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
  const next: ClientState = {
    ...state,
    ratchetTree: tree,
    groupContext: {
      ...state.groupContext,
      epoch: BigInt(mls.epoch()),
      confirmedTranscriptHash: changingEpoch
        ? sha256(
            new TextEncoder().encode(`kumiai/test-transcript/v1:${toB64U(mls.authenticator())}`),
          )
        : state.groupContext.confirmedTranscriptHash,
      extensions: [
        ...state.groupContext.extensions.filter(
          (extension) => extension.extensionType !== LEDGER_HEAD_EXTENSION_TYPE,
        ),
        buildLedgerHeadExtension(fromB64U(mls.authenticatedLedgerHead())),
      ],
    },
    keySchedule: {
      ...state.keySchedule,
      epochAuthenticator: mls.authenticator(),
      resumptionPsk: mls.authenticator(),
    },
    ...(changingEpoch
      ? {
          secretTree: freshSecretTree(mls),
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
    confirmationTag: serializeModel(mls),
  }
  captureReceiveState(next, mls)
  next.confirmationTag = serializeModel(mls)
  return next
}

export function seedMemoryControlState(
  state: ClientState,
  credential: MemberCredential,
  ledgerEntries: Array<string> = [],
) {
  const seeded = structuredClone(state)
  if (
    !seeded.groupContext.extensions.some(
      (extension) => extension.extensionType === GROUP_ANCHOR_EXTENSION_TYPE,
    )
  )
    seeded.groupContext.extensions.push(
      buildGroupAnchorExtension({ creatorDID: credential.id, version: 1 }),
    )
  const mls = model(seeded, credential, false, false, {}, ledgerEntries)
  seeded.secretTree = freshSecretTree(mls)
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
  // Model snapshots must use the same wire-normalised shape as a restored handle.
  const canonical = decodeClientState(encodeClientState(state))
  if (canonical === undefined) throw new Error('Invalid memory receive state')
  mls.setReceiveHistory(
    [...canonical.historicalReceiverData].map(([at, held]) => [
      Number(at),
      {
        identity: toB64U(held.resumptionPsk),
        state: encodeStoredValue(held),
      },
    ]),
  )
  mls.setReceiveState(encodeStoredValue(receiverData(canonical)))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function appKey(epoch: bigint, authenticator: Uint8Array): Uint8Array {
  return fakeEpochSecret(Number(epoch), 'app', 32, authenticator)
}

function appTag(key: Uint8Array, frame: PrivateMessage, leaf: number, generation: number) {
  return hmac(
    sha256,
    key,
    new TextEncoder().encode(
      JSON.stringify([
        toB64U(frame.groupId),
        String(frame.epoch),
        frame.contentType,
        leaf,
        generation,
        toB64U(frame.authenticatedData),
        toB64U(frame.ciphertext),
      ]),
    ),
  )
}

function appCrypt(key: Uint8Array, leaf: number, generation: number, bytes: Uint8Array) {
  const result = bytes.slice()
  for (let offset = 0; offset < result.length; offset += 32) {
    const stream = hmac(
      sha256,
      key,
      new TextEncoder().encode(JSON.stringify(['stream', leaf, generation, offset / 32])),
    )
    for (let index = 0; index < Math.min(32, result.length - offset); index++)
      result[offset + index] = (result[offset + index] as number) ^ (stream[index] as number)
  }
  return result
}

function stepRatchet(ratchet: GenerationSecret): void {
  ratchet.secret = hmac(
    sha256,
    ratchet.secret,
    new TextEncoder().encode(`next:${ratchet.generation}`),
  )
  ratchet.generation += 1
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
    this.#view.groupContext.extensions = [
      ...this.#view.groupContext.extensions.filter(
        (extension) => extension.extensionType !== LEDGER_HEAD_EXTENSION_TYPE,
      ),
      buildLedgerHeadExtension(fromB64U(this.#mls.authenticatedLedgerHead())),
    ]
    // Keep the live progress buffers visible; only the durable model snapshot is copied.
    captureReceiveState(this.#view, this.#mls)
    this.#view.confirmationTag = serializeModel(this.#mls)
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

  #projection(): GroupHandle {
    return new GroupHandle({
      state: this.state,
      credential: this.credential,
      // Do not replace the live context's deny provider with a snapshot.
      context: { ...this.context },
      ledger: this.#mls.ledgerTokens().map((token) => {
        const verified = verifiedLedgers.get(this.#mls)?.get(token)
        if (verified === undefined) throw new Error('Unverified memory ledger projection')
        return { token, verified, entryID: ledgerEntryDigest(token) }
      }),
    })
  }

  override get ledger(): GroupHandle['ledger'] {
    return models.has(this) ? this.#projection().ledger : super.ledger
  }
  override get ledgerTokens(): GroupHandle['ledgerTokens'] {
    return models.has(this) ? this.#projection().ledgerTokens : super.ledgerTokens
  }
  override get roster(): GroupHandle['roster'] {
    return models.has(this) ? this.#projection().roster : super.roster
  }
  override get registry(): GroupHandle['registry'] {
    return models.has(this) ? this.#projection().registry : super.registry
  }
  override currentDenySet() {
    return models.has(this) ? this.#projection().currentDenySet() : super.currentDenySet()
  }
  override revokedDevices() {
    return this.#projection().revokedDevices()
  }
  override async getLedger() {
    return this.ledgerTokens
  }
  override async isLedgerComplete() {
    return this.#projection().isLedgerComplete()
  }

  override async applyLedgerEntries(tokens: Array<string>): Promise<Array<VerifiedLedgerEntry>> {
    await this.#mls.applyLedgerEntries(tokens)
    return tokens.map((token) => {
      const verified = verifiedLedgers.get(this.#mls)?.get(token)
      if (verified === undefined) throw new Error('Unverified memory ledger projection')
      return verified
    })
  }

  override async bootstrapLedger(
    tokens: Array<string>,
    opts?: { persist?: (handle: GroupHandle) => Promise<void> | void },
  ): Promise<void> {
    await this.#mls.bootstrapLedger(
      tokens,
      opts?.persist === undefined ? undefined : () => opts.persist?.(this),
    )
  }

  override sendAdmission(): SendAdmission {
    return this.#projection().sendAdmission()
  }

  override async exportSecret(
    label: string,
    context: Uint8Array,
    length = 32,
  ): Promise<Uint8Array> {
    return exportedSecret(this.#view, this.#mls, label, context, length)
  }

  override async encrypt(plaintext: Uint8Array, opts?: { aad?: Uint8Array }): Promise<Uint8Array> {
    return mutexFor(this).run(async () => {
      const state = this.state
      if (state.groupActiveState.kind !== 'active') throw new Error('Inactive memory group')
      if (!this.sendAdmission().admissible) throw new LeafLapsedError('lapsed')
      const leaf = state.privatePath.leafIndex
      const ratchet = state.secretTree.leafNodes[leaf * 2]?.application
      if (ratchet === undefined) throw new Error('Missing memory sender ratchet')
      const generation = ratchet.generation
      const senderData = new Uint8Array(8)
      const view = new DataView(senderData.buffer)
      view.setUint32(0, leaf)
      view.setUint32(4, generation)
      const key = appKey(state.groupContext.epoch, this.#mls.authenticator())
      const frame: PrivateMessage = {
        groupId: state.groupContext.groupId,
        epoch: state.groupContext.epoch,
        contentType: contentTypes.application,
        authenticatedData: opts?.aad ?? new Uint8Array(),
        encryptedSenderData: senderData,
        ciphertext: appCrypt(key, leaf, generation, plaintext),
      }
      frame.ciphertext = new Uint8Array([
        ...frame.ciphertext,
        ...appTag(key, frame, leaf, generation),
      ])
      const bytes = encode(mlsMessageEncoder, {
        version: protocolVersions.mls10,
        wireformat: wireformats.mls_private_message,
        privateMessage: frame,
      })
      stepRatchet(ratchet)
      captureReceiveState(this.#view, this.#mls)
      return bytes
    })
  }

  #open(message: Uint8Array, opts: { expectedAAD?: Uint8Array }) {
    const decoded = decode(mlsMessageDecoder, message)
    if (
      decoded?.wireformat !== wireformats.mls_private_message ||
      decoded.privateMessage.contentType !== contentTypes.application
    )
      throw new Error('Not a PrivateMessage application frame')
    const frame = decoded.privateMessage
    if (opts.expectedAAD !== undefined && !sameBytes(frame.authenticatedData, opts.expectedAAD))
      throw new Error('Frame authenticated data does not match expected AAD')
    const state = this.state
    const receiver =
      frame.epoch === state.groupContext.epoch
        ? receiverData(state)
        : state.historicalReceiverData.get(frame.epoch)
    if (receiver === undefined) throw new Error('Unavailable memory epoch')
    if (!sameBytes(frame.groupId, receiver.groupContext.groupId))
      throw new Error('Memory group mismatch')
    if (frame.encryptedSenderData.length !== 8) throw new Error('Invalid memory sender data')
    const view = new DataView(
      frame.encryptedSenderData.buffer,
      frame.encryptedSenderData.byteOffset,
      frame.encryptedSenderData.byteLength,
    )
    const leaf = view.getUint32(0)
    const generation = view.getUint32(4)
    const node = receiver.ratchetTree[leaf * 2]
    if (node?.nodeType !== 1 || !('identity' in node.leaf.credential))
      throw new Error('Unnamed memory sender')
    const senderDID = parseMLSCredentialIdentity(node.leaf.credential.identity).id
    assertSenderNotLapsed({
      group: this,
      tree: receiver.ratchetTree,
      leafIndex: leaf,
      extensions: receiver.groupContext.extensions,
    })
    const key = appKey(frame.epoch, receiver.resumptionPsk)
    const ciphertext = frame.ciphertext.slice(0, -32)
    if (
      frame.ciphertext.length < 32 ||
      !sameBytes(
        frame.ciphertext.slice(-32),
        appTag(key, { ...frame, ciphertext }, leaf, generation),
      )
    )
      throw new Error('Invalid memory application tag')
    const staged = structuredClone(state)
    const tree =
      frame.epoch === staged.groupContext.epoch
        ? staged.secretTree
        : staged.historicalReceiverData.get(frame.epoch)?.secretTree
    const ratchet = tree?.leafNodes[leaf * 2]?.application
    if (ratchet === undefined) throw new Error('Missing memory receiver ratchet')
    const config = this.context.clientConfig?.keyRetentionConfig ?? defaultKeyRetentionConfig
    if (generation < ratchet.generation) {
      if (ratchet.unusedGenerations[generation] === undefined)
        throw new Error('Desired gen in the past')
      delete ratchet.unusedGenerations[generation]
    } else {
      if (generation - ratchet.generation > config.maximumForwardRatchetSteps)
        throw new Error('Desired generation too far in the future')
      while (ratchet.generation < generation) {
        ratchet.unusedGenerations[ratchet.generation] = ratchet.secret
        stepRatchet(ratchet)
      }
      const unused = Object.keys(ratchet.unusedGenerations)
        .map(Number)
        .sort((a, b) => a - b)
      for (const old of unused.slice(
        0,
        Math.max(0, unused.length - config.retainKeysForGenerations),
      ))
        delete ratchet.unusedGenerations[old]
      stepRatchet(ratchet)
    }
    return {
      staged,
      opened: {
        payload: appCrypt(key, leaf, generation, ciphertext),
        senderDID,
        aad: frame.authenticatedData,
      },
    }
  }

  override async decrypt(message: Uint8Array, opts: { expectedAAD?: Uint8Array } = {}) {
    return mutexFor(this).run(async () => {
      const { staged, opened } = this.#open(message, opts)
      Object.assign(this.#view, staged)
      // A later envelope rebuild reads retained trees from the model's snapshot.
      captureReceiveState(this.#view, this.#mls)
      return opened
    })
  }

  override async decryptStaged(
    message: Uint8Array,
    opts: { expectedAAD?: Uint8Array },
    persist: (
      stagedState: Uint8Array,
      opened: { payload: Uint8Array; senderDID: string; aad: Uint8Array },
    ) => Promise<void>,
  ) {
    return mutexFor(this).run(async () => {
      const { staged, opened } = this.#open(message, opts)
      await persist(encodeClientState(staged), opened)
      Object.assign(this.#view, staged)
      captureReceiveState(this.#view, this.#mls)
      return opened
    })
  }

  override async processMessage(
    message: Parameters<GroupHandle['processMessage']>[0],
    opts?: Parameters<GroupHandle['processMessage']>[1],
  ): Promise<Uint8Array | null> {
    if (!(message instanceof Uint8Array) || opts?.commitPolicy || this.commitPolicy)
      throw new Error('Unsupported memory commit input or policy')
    return mutexFor(this).run(async () => {
      const header = await this.#mls.readCommitHeader(message)
      if (header === null) throw new Error('Invalid memory commit')
      const previous = this.#mls.serializeState()
      const view = structuredClone(this.state)
      try {
        const result = await this.#mls.processCommit(message, {
          senderDID: header.committerDID,
          resolveLedgerEntries: this.resolveLedgerEntries,
        })
        if (!result.applied) throw new Error('Memory commit refused')
        this.state
        await opts?.persist?.(this)
        return null
      } catch (error) {
        this.#mls.restoreState(previous)
        Object.assign(this.#view, view)
        throw error
      }
    })
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
    candidate.#view.confirmationTag = serializeModel(candidate.#mls)
  }
}

export async function restoreMemoryControlHandle(params: {
  state: ClientState
  credential: MemberCredential
  ledgerEntries?: Array<string>
  options?: GroupOptions
}): Promise<GroupHandle> {
  const { credential, ledgerEntries, options = {} } = params
  let state: ClientState
  let mls: MemoryMLS
  let tokens: Array<string>
  try {
    state = structuredClone(params.state)
    const ownLeaf = state.ratchetTree[state.privatePath.leafIndex * 2]
    if (
      new TextDecoder().decode(state.groupContext.groupId) !== credential.groupID ||
      (state.groupActiveState.kind !== 'removedFromGroup' &&
        (ownLeaf?.nodeType !== 1 ||
          !('identity' in ownLeaf.leaf.credential) ||
          parseMLSCredentialIdentity(ownLeaf.leaf.credential.identity).id !== credential.id))
    )
      throw new InvalidCandidateError('Memory handle owner or group mismatch')
    mls = model(state, credential, true, false, options)
    if (
      BigInt(mls.epoch()) !== state.groupContext.epoch ||
      toB64U(mls.authenticator()) !== toB64U(state.keySchedule.epochAuthenticator)
    )
      throw new InvalidCandidateError('Memory state identity mismatch')
    tokens = mls.ledgerTokens()
    if (
      ledgerEntries !== undefined &&
      (tokens.length !== ledgerEntries.length ||
        tokens.some((token, index) => token !== ledgerEntries[index]))
    )
      throw new InvalidCandidateError('Memory ledger projection mismatch')
  } catch (cause) {
    if (cause instanceof InvalidCandidateError) throw cause
    throw new InvalidCandidateError(
      cause instanceof Error ? cause.message : 'Invalid memory candidate',
      { cause },
    )
  }
  // Reuse only context construction and signed ledger folding, never MLS transitions.
  const restored = restrictCommitAuthoring(
    await restoreGroup({
      state,
      credential: { ...credential },
      ledgerEntries: tokens,
      options,
    }),
  )
  if (restored.ledgerTokens.length !== tokens.length)
    throw new InvalidCandidateError('Invalid memory ledger')
  if (toB64U(readLedgerHead(restored)?.head ?? new Uint8Array()) !== mls.authenticatedLedgerHead())
    throw new InvalidCandidateError('Memory authenticated ledger head mismatch')
  const verified = verifiedLedgers.get(mls)
  if (verified === undefined) throw new Error('Missing memory verification cache')
  for (const entry of restored.ledger) verified.set(entry.token, entry.verified)
  return restrictCommitAuthoring(
    new MemoryControlHandle({
      state,
      credential: restored.credential,
      context: restored.context,
      ledger: restored.ledger,
      commitPolicy: options.commitPolicy,
      resolveLedgerEntries: options.resolveLedgerEntries,
      onLedgerEntries: options.onLedgerEntries,
      model: mls,
    }),
  )
}

// Raw-key clone for permit restores and isolated model tests; ordinary restores stay restricted.
export async function restoreMemoryControlSource(
  params: Parameters<typeof restoreMemoryControlHandle>[0],
): Promise<GroupHandle> {
  const restored = await restoreMemoryControlHandle(params)
  const source = await restoreGroup({
    state: restored.state,
    credential: restored.credential,
    ledgerEntries: restored.ledgerTokens,
    options: params.options,
  })
  models.set(source, memoryModel(restored))
  return source
}

export async function buildSealedMemoryOperation(
  op: Operation,
  handle: GroupHandle,
): Promise<HostBuilt> {
  return authorPrivateCommit(handle, async () => {
    const sourceState = handle.state
    const mls = memoryModel(handle)
    const own = sourceState.secretTree.leafNodes[2 * sourceState.privatePath.leafIndex]
    if (own === undefined) throw new Error('Missing memory author ratchet')
    stepRatchet(own.handshake)
    captureReceiveState(sourceState, mls)
    const before = mls.serializeState()
    const epoch = mls.epoch()
    const authenticatorBefore = mls.authenticator()
    const { target } = decodeStoredValue(op.body) as { target: string }
    const commit = mls.buildCommit([], { adds: [target] })
    let candidate: Uint8Array
    let candidateAuthenticator: Uint8Array
    try {
      await mls.adopt(commit)
      candidate = encodeClientState(envelope(sourceState, mls))
      candidateAuthenticator = mls.authenticator().slice()
    } finally {
      mls.restoreState(before)
    }
    const welcome = new TextEncoder().encode(target)
    return {
      receipt: {
        commit,
        welcome: welcome.slice(),
        referencedProposals: [],
        epoch,
        authenticatorBefore,
        candidateAuthenticator,
      },
      value: {
        commit,
        bodies: [],
        journal: candidate,
        welcome: { bytes: welcome, recipients: [target] },
        incarnation: 1,
        epoch,
        authenticatorBefore,
        digest: toB64U(sha256(commit)),
      },
    }
  })
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

export const independentCheckpointFrame = memoryCheckpointFrame
