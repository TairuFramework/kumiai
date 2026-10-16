import {
  encodeMultibase,
  isVerifiedToken,
  normalizeDID,
  type SigningIdentity,
  stringifyToken,
} from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromB64U, toB64U } from '@sozai/codec'
import {
  type ClientState,
  ciphersuites,
  defaultExtensionTypes,
  encode,
  type LeafNodeInfoOmitted,
  type MlsContext,
  type MlsGroupInfo,
  makeCustomExtension,
  mlsMessageDecoder,
  mlsMessageEncoder,
} from 'ts-mls'

import { LEDGER_HEAD_EXTENSION_TYPE, readGroupAnchorExtension } from './anchor.js'
import {
  checkpointAuthHash,
  checkpointGenesisHash,
  checkpointKeyHash,
  checkpointSignatureInput,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
} from './checkpoint-codec.js'
import { didFromCredential } from './credential.js'
import { LeafBindingError } from './errors.js'
import { exportGroupInfo, type GroupHandle, readGroupInfoBinding } from './group.js'
import { computeHead, decodeLedgerHead, headsMatch } from './head.js'
import { type LedgerEntry, ledgerEntryDigest } from './ledger.js'
import {
  decodeLedgerTokens,
  encodeLedgerTokens,
  openSealedReply,
  RecoveryRequestError,
  SealedGroupInfoError,
  type SealedReplyKind,
  sealToRequest,
  verifyRecoveryRequest,
  verifyRecoveryToken,
} from './recovery.js'
import {
  assertTrustedRecoveryOwner,
  assertTrustedRecoverySigner,
  publicRecoveryGroup,
  type RecoveryTrustInputs,
} from './recovery-trust.js'
import { foldControl } from './registry.js'
import type { GroupOptions } from './types.js'

const utf8 = new TextEncoder()
const text = new TextDecoder('utf-8', { fatal: true })
const MAX_REPLY = 786432
const SEAL_OVERHEAD = 49
const ROSTER_TYPE = 'kumiai.recovery-roster'
const ROSTER_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery-roster/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-roster-aad/v1'),
  version: 1,
  fail: (reason, message, options) => new SealedGroupInfoError(reason, message, options),
}

export type AuthenticatedRosterAbsence = {
  groupID: string
  requesterDID: string
  requestID: string
  epoch: number
  captureHead: string | null
  groupInfoAuthenticator: Uint8Array
  confirmedTranscriptHash: string
  responderDID: string
  responderKeyHash: string
  lineage: Array<{ epoch: number; authHash: string }>
  evidence: Uint8Array
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function field(bytes: Uint8Array): Uint8Array {
  return concat([u32(bytes.length), bytes])
}

function invalid(): never {
  throw new SealedGroupInfoError('malformed', 'Invalid public recovery roster')
}

type ReaderParams = { bytes: Uint8Array }

class Reader {
  #bytes: Uint8Array
  #offset = 0

  constructor(params: ReaderParams) {
    this.#bytes = params.bytes
  }

  get offset(): number {
    return this.#offset
  }
  get done(): boolean {
    return this.#offset === this.#bytes.length
  }

  take(length: number): Uint8Array {
    if (length > this.#bytes.length - this.#offset) invalid()
    const bytes = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return bytes
  }

  number(width: number): number {
    let value = 0
    for (const byte of this.take(width)) value = value * 256 + byte
    return value
  }

  field(): Uint8Array {
    return this.take(this.number(4))
  }

  vector(): Uint8Array {
    const first = this.number(1)
    const width = 1 << (first >>> 6)
    if (width === 8) invalid()
    let size = first & 63
    for (const byte of this.take(width - 1)) size = size * 256 + byte
    return this.take(size)
  }
}

function vector(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  if (length >= 0x40000000) invalid()
  const width = length < 64 ? 1 : length < 16384 ? 2 : 4
  const prefix = u32(length | (width === 1 ? 0 : width === 2 ? 0x4000 : 0x80000000))
  return concat([prefix.subarray(4 - width), bytes])
}

type PublicTree = {
  tree: ClientState['ratchetTree']
  bodies: Array<Uint8Array>
  encoded: Uint8Array
}

function numbers(bytes: Uint8Array, width: number): Array<number> {
  const reader = new Reader({ bytes })
  const values: Array<number> = []
  while (!reader.done) values.push(reader.number(width))
  return values
}

// ts-mls exports no public tree/leaf codecs. Read RFC 9420 public fields without inventing private state.
export function readRecoveryPublicTree(message: MlsGroupInfo): PublicTree {
  const entries = message.groupInfo.extensions.filter(
    (entry) => entry.extensionType === defaultExtensionTypes.ratchet_tree,
  )
  const encoded = entries[0]?.extensionData
  if (entries.length !== 1 || !(encoded instanceof Uint8Array)) invalid()
  const frame = new Reader({ bytes: encoded })
  const bytes = frame.vector()
  if (!frame.done) invalid()
  const reader = new Reader({ bytes })
  const tree: ClientState['ratchetTree'] = []
  const bodies: Array<Uint8Array> = []
  while (!reader.done) {
    const present = reader.number(1)
    if (present === 0) {
      tree.push(undefined)
      bodies.push(new Uint8Array([0]))
      continue
    }
    if (present !== 1) invalid()
    const type = reader.number(1)
    const start = reader.offset
    if (type !== (tree.length % 2 === 0 ? 1 : 2)) invalid()
    if (type === 2) {
      const hpkePublicKey = reader.vector()
      const parentHash = reader.vector()
      const unmergedLeaves = numbers(reader.vector(), 4)
      tree.push({ nodeType: 2, parent: { hpkePublicKey, parentHash, unmergedLeaves } })
    } else {
      const hpkePublicKey = reader.vector()
      const signaturePublicKey = reader.vector()
      // Kumiai authenticates DID basic credentials, never X.509 or opaque credentials.
      if (reader.number(2) !== 1) invalid()
      const credential = { credentialType: 1 as const, identity: reader.vector() }
      const capabilities = {
        versions: numbers(reader.vector(), 2),
        ciphersuites: numbers(reader.vector(), 2),
        extensions: numbers(reader.vector(), 2),
        proposals: numbers(reader.vector(), 2),
        credentials: numbers(reader.vector(), 2),
      }
      const source = reader.number(1)
      let info: LeafNodeInfoOmitted
      if (source === 1) {
        const lifetime = reader.take(16)
        const view = new DataView(lifetime.buffer, lifetime.byteOffset, lifetime.byteLength)
        info = {
          leafNodeSource: 1,
          lifetime: { notBefore: view.getBigUint64(0), notAfter: view.getBigUint64(8) },
          extensions: [],
        }
      } else if (source === 2) info = { leafNodeSource: 2, extensions: [] }
      else if (source === 3)
        info = { leafNodeSource: 3, parentHash: reader.vector(), extensions: [] }
      else invalid()
      const extensions = new Reader({ bytes: reader.vector() })
      while (!extensions.done)
        info.extensions.push(
          makeCustomExtension({
            extensionType: extensions.number(2),
            extensionData: extensions.vector(),
          }),
        )
      const signature = reader.vector()
      tree.push({
        nodeType: 1,
        leaf: { hpkePublicKey, signaturePublicKey, credential, capabilities, ...info, signature },
      })
    }
    bodies.push(concat([new Uint8Array([1]), bytes.subarray(start, reader.offset)]))
  }
  if (tree.length === 0 || tree.at(-1) === undefined) invalid()
  const width = 2 ** Math.ceil(Math.log2(tree.length + 1)) - 1
  while (tree.length < width) {
    tree.push(undefined)
    bodies.push(new Uint8Array([0]))
  }
  return { tree, bodies, encoded }
}

/** @internal RFC 9420 GroupInfoTBS and tree hash verification, independent of receiver secrets. */
export async function verifyRecoveryPublicGroupInfo(
  message: MlsGroupInfo,
  suite: MlsContext['cipherSuite'],
): Promise<boolean> {
  let publicTree: PublicTree
  let signatureKey: Uint8Array
  let input: Uint8Array
  try {
    if (message.groupInfo.groupContext.cipherSuite !== suite.id) return false
    publicTree = readRecoveryPublicTree(message)
    const signer = publicTree.tree[message.groupInfo.signer * 2]
    if (signer?.nodeType !== 1) return false
    signatureKey = signer.leaf.signaturePublicKey
    const suiteName = Object.entries(ciphersuites).find(([, id]) => id === suite.id)?.[0]
    const shape = suiteName?.endsWith('_Ed25519')
      ? [64, 32]
      : suiteName?.endsWith('_Ed448')
        ? [114, 57]
        : undefined
    if (shape == null) return false
    if (message.groupInfo.signature.length !== shape[0]) return false
    if (signatureKey.length !== shape[1]) return false
    const unsigned = encode(mlsMessageEncoder, {
      ...message,
      groupInfo: { ...message.groupInfo, signature: new Uint8Array() },
    }).subarray(4, -1)
    input = concat([vector(utf8.encode('MLS 1.0 GroupInfoTBS')), vector(unsigned)])
  } catch {
    return false
  }
  // Provider faults are operational failures, not evidence rejection.
  if (!(await suite.signature.verify(signatureKey, input, message.groupInfo.signature)))
    return false
  const hash = async (index: number): Promise<Uint8Array> => {
    const body = publicTree.bodies[index] ?? new Uint8Array([0])
    if (index % 2 === 0)
      return await suite.hash.digest(concat([new Uint8Array([1]), u32(index / 2), body]))
    let level = 0
    while (((index >>> level) & 1) === 1) level++
    const left = await hash(index ^ (1 << (level - 1)))
    const right = await hash(index ^ (3 << (level - 1)))
    return await suite.hash.digest(concat([new Uint8Array([2]), body, vector(left), vector(right)]))
  }
  const root = 2 ** Math.floor(Math.log2(publicTree.tree.length)) - 1
  return headsMatch(await hash(root), message.groupInfo.groupContext.treeHash)
}

function encodeCheckpoints(frames: Array<Uint8Array>): Uint8Array {
  return concat([u32(frames.length), ...frames.map(field)])
}

function decodeCheckpoints(bytes: Uint8Array): Array<Uint8Array> {
  const reader = new Reader({ bytes })
  const count = reader.number(4)
  if (count === 0 || count > 256) invalid()
  const frames: Array<Uint8Array> = []
  for (let i = 0; i < count; i++) {
    const frame = reader.field()
    if (frame.length > 4096) invalid()
    frames.push(frame)
  }
  if (!reader.done) invalid()
  return frames
}

function lineageForKey(params: {
  frames: Array<Uint8Array>
  publicKey: Uint8Array
  groupID: string
  genesisHash: string
  ciphersuite: number
  epoch: number
  authHash: string
}): Array<{ epoch: number; authHash: string }> | null {
  if (params.frames.length === 0 || params.frames.length > 256) return null
  let frames: Array<ReturnType<typeof decodeEpochCheckpoint>>
  try {
    frames = params.frames.map(decodeEpochCheckpoint)
  } catch {
    return null
  }
  let previous: (typeof frames)[number] | undefined
  for (const frame of frames) {
    const body = frame.body
    if (
      body.groupID !== params.groupID ||
      body.genesisHash !== params.genesisHash ||
      body.ciphersuite !== params.ciphersuite ||
      body.keyHash !== checkpointKeyHash(params.publicKey) ||
      (previous !== undefined &&
        (body.epoch !== previous.body.epoch + 1 ||
          body.parentAuthHash !== previous.body.authHash)) ||
      !ed25519.verify(frame.signature, checkpointSignatureInput(body), params.publicKey, {
        zip215: false,
      })
    )
      return null
    previous = frame
  }
  if (previous?.body.epoch !== params.epoch || previous.body.authHash !== params.authHash)
    return null
  return frames.map(({ body }) => ({ epoch: body.epoch, authHash: body.authHash }))
}

export async function verifyRecoveryLineage(params: {
  trust: RecoveryTrustInputs
  frames: Array<Uint8Array>
  signerKeyHash: string
  epoch: number
  authHash: string
}): Promise<Array<{ epoch: number; authHash: string }> | null> {
  const { trust } = params
  const leaves = trust.signerTree.filter(
    (node) =>
      node?.nodeType === 1 &&
      checkpointKeyHash(node.leaf.signaturePublicKey) === params.signerKeyHash,
  )
  const signer = leaves[0]
  if (leaves.length !== 1 || signer?.nodeType !== 1) return null
  const did = didFromCredential(signer.leaf.credential)
  if (did === null) return null
  try {
    const group = await publicRecoveryGroup(trust, {})
    await assertTrustedRecoverySigner(group, trust, did, signer.leaf.signaturePublicKey)
    return lineageForKey({
      ...params,
      groupID: trust.groupID,
      genesisHash: checkpointGenesisHash(trust.genesisAnchor),
      ciphersuite: group.context.cipherSuite.id,
      publicKey: signer.leaf.signaturePublicKey,
    })
  } catch (error) {
    if (error instanceof SealedGroupInfoError || error instanceof LeafBindingError) return null
    throw error
  }
}

/** A changed leaf never proves DID absence. A present DID with an obsolete incarnation can remain pending. */
export async function sealRosterAbsenceReply(params: {
  group: GroupHandle
  identity: SigningIdentity
  request: string
  captureHead: string | null
  /** Coordinator-owned retained installations only. Imported facts and notice summaries grant no disclosure authority. */
  retainedRosterFacts: Array<Uint8Array>
  lineage: Array<Uint8Array>
}): Promise<Uint8Array | null> {
  const { group, identity, request, captureHead } = params
  if (normalizeDID(identity.id) !== normalizeDID(group.credential.id))
    throw new Error('Roster responder identity mismatch')
  if (
    captureHead !== null &&
    (typeof captureHead !== 'string' || captureHead.length === 0 || captureHead.length > 64)
  )
    throw new TypeError('Invalid capture head')
  let verified: Awaited<ReturnType<typeof verifyRecoveryRequest>>
  try {
    verified = await verifyRecoveryRequest(request)
  } catch (error) {
    if (error instanceof RecoveryRequestError) return null
    throw error
  }
  const epoch = Number(group.epoch)
  const comparisonEpoch = verified.comparisonEpoch
  if (
    verified.groupID !== group.groupID ||
    comparisonEpoch === undefined ||
    epoch < comparisonEpoch ||
    group.findMemberLeafIndex(verified.requesterDID) !== undefined
  )
    return null
  const anchor = readGroupInfoAnchor(group)
  const genesisHash = checkpointGenesisHash(anchor)
  const eligible = params.retainedRosterFacts.some((bytes) => {
    const fact = decodeEpochRosterFact(bytes)
    return (
      fact.key.groupID === group.groupID &&
      fact.genesisHash === genesisHash &&
      fact.ciphersuite === group.context.cipherSuite.id &&
      fact.epoch < epoch &&
      fact.members.some(
        (member) =>
          member.signerDID === verified.requesterDID &&
          member.keyHash === verified.requesterKeyHash,
      )
    )
  })
  if (!eligible) return null
  let frames: Array<Uint8Array>
  try {
    frames = params.lineage.filter((frame) => {
      const body = decodeEpochCheckpoint(frame).body
      return body.epoch >= comparisonEpoch && body.epoch <= epoch
    })
  } catch {
    return null
  }
  const authenticator = group.state.keySchedule.epochAuthenticator.slice()
  const authHash = checkpointAuthHash({
    groupID: group.groupID,
    genesisHash,
    epoch,
    epochAuthenticator: authenticator,
  })
  if (
    lineageForKey({
      frames,
      publicKey: identity.publicKey,
      groupID: group.groupID,
      genesisHash,
      ciphersuite: group.context.cipherSuite.id,
      epoch,
      authHash,
    }) === null
  )
    return null
  // The caller holds one owner gate across head, public state, ledger and retained facts/frames.
  const tokens = group.ledgerTokens
  if (!(await group.isLedgerComplete())) return null
  const { groupInfo } = await exportGroupInfo({ group })
  const message = parseGroupInfo(groupInfo)
  const tree = readRecoveryPublicTree(message)
  const ledger = encodeLedgerTokens(tokens)
  for (;;) {
    const lineage = encodeCheckpoints(frames)
    const signed = await identity.signToken(
      {
        type: ROSTER_TYPE,
        groupID: group.groupID,
        requesterDID: verified.requesterDID,
        requestID: verified.requestID,
        request,
        captureHead,
        groupInfoAuthenticator: toB64U(authenticator),
        groupInfoDigest: digest(groupInfo),
        treeDigest: digest(tree.encoded),
        ledgerDigest: digest(ledger),
        lineageDigest: digest(lineage),
      },
      { embedLongForm: true },
    )
    const plaintext = concat([
      field(utf8.encode(stringifyToken(signed))),
      field(groupInfo),
      field(ledger),
      lineage,
    ])
    if (plaintext.length + SEAL_OVERHEAD <= MAX_REPLY) {
      const sealed = await sealToRequest({
        kind: ROSTER_REPLY,
        group,
        request,
        plaintext,
        requireMember: false,
      })
      return sealed.length <= MAX_REPLY ? sealed : null
    }
    if (frames.length === 1) return null
    // Keep the nearest complete suffix, including F. Never truncate the public state.
    frames = frames.slice(1)
  }
}

function digest(bytes: Uint8Array): string {
  return encodeMultibase(sha256(bytes))
}

function readGroupInfoAnchor(group: GroupHandle): Uint8Array {
  const extension = readGroupAnchorExtension(group)
  if (!(extension?.extensionData instanceof Uint8Array)) invalid()
  return extension.extensionData
}

function parseGroupInfo(bytes: Uint8Array): MlsGroupInfo {
  try {
    const decoded = mlsMessageDecoder(bytes, 0)
    if (decoded === undefined || decoded[1] !== bytes.length || decoded[0].wireformat !== 4)
      invalid()
    return decoded[0]
  } catch {
    return invalid()
  }
}

export async function verifyRosterAbsence(params: {
  trust: RecoveryTrustInputs
  requestID: string
  requestKey: Uint8Array
  evidence: Uint8Array
  options: GroupOptions
}): Promise<AuthenticatedRosterAbsence | null> {
  const { trust, requestID, requestKey, evidence, options } = params
  if (requestKey.length !== 32) throw new Error('Invalid retained recovery request key length')
  if (evidence.length > MAX_REPLY) return null
  try {
    const group = await publicRecoveryGroup(trust, options)
    await assertTrustedRecoveryOwner(group, trust)
    const plaintext = await openSealedReply({
      kind: ROSTER_REPLY,
      group,
      sealed: evidence,
      requestID,
      ephemeralPrivateKey: requestKey,
    })
    const reader = new Reader({ bytes: plaintext })
    const tokenBytes = reader.field()
    let token: string
    try {
      token = text.decode(tokenBytes)
    } catch {
      return null
    }
    const groupInfo = reader.field()
    const ledgerBytes = reader.field()
    const lineageBytes = reader.take(plaintext.length - reader.offset)
    const signed = await verifyRecoveryToken(token, group.context)
    if (!isVerifiedToken(signed)) return null
    const payload = signed.payload
    if (
      payload.type !== ROSTER_TYPE ||
      payload.groupID !== trust.groupID ||
      payload.requestID !== requestID ||
      typeof payload.request !== 'string' ||
      payload.groupInfoDigest !== digest(groupInfo) ||
      payload.ledgerDigest !== digest(ledgerBytes) ||
      payload.lineageDigest !== digest(lineageBytes)
    )
      return null
    const request = await verifyRecoveryRequest(payload.request, requestKey)
    if (
      request.groupID !== trust.groupID ||
      request.requestID !== requestID ||
      request.requesterDID !== normalizeDID(trust.credential.id) ||
      payload.requesterDID !== request.requesterDID ||
      request.comparisonEpoch === undefined
    )
      return null
    await assertTrustedRecoverySigner(group, trust, signed.payload.iss, signed.verifiedPublicKey)
    if (
      payload.captureHead !== null &&
      (typeof payload.captureHead !== 'string' ||
        payload.captureHead.length === 0 ||
        payload.captureHead.length > 64)
    )
      return null
    if (typeof payload.groupInfoAuthenticator !== 'string') return null
    let authenticator: Uint8Array
    try {
      authenticator = fromB64U(payload.groupInfoAuthenticator)
    } catch {
      return null
    }
    if (
      authenticator.length !== group.context.cipherSuite.kdf.size ||
      toB64U(authenticator) !== payload.groupInfoAuthenticator
    )
      return null
    const info = parseGroupInfo(groupInfo)
    const binding = readGroupInfoBinding(groupInfo)
    if (
      binding.groupID !== trust.groupID ||
      binding.anchorExtensionData === null ||
      !headsMatch(binding.anchorExtensionData, trust.genesisAnchor)
    )
      return null
    if (!(await verifyRecoveryPublicGroupInfo(info, group.context.cipherSuite))) return null
    const tree = readRecoveryPublicTree(info)
    if (payload.treeDigest !== digest(tree.encoded)) return null
    const signer = normalizeDID(signed.payload.iss)
    const offeredSigner = tree.tree[info.groupInfo.signer * 2]
    if (
      offeredSigner?.nodeType !== 1 ||
      didFromCredential(offeredSigner.leaf.credential) !== signer ||
      !headsMatch(offeredSigner.leaf.signaturePublicKey, signed.verifiedPublicKey)
    )
      return null
    if (
      tree.tree.some(
        (node) =>
          node?.nodeType === 1 && didFromCredential(node.leaf.credential) === request.requesterDID,
      )
    )
      return null
    let ledger: Array<string>
    try {
      ledger = decodeLedgerTokens(ledgerBytes)
    } catch {
      return null
    }
    const extensions = info.groupInfo.groupContext.extensions.filter(
      (entry) => entry.extensionType === LEDGER_HEAD_EXTENSION_TYPE,
    )
    const data = extensions[0]?.extensionData
    const head = data instanceof Uint8Array ? decodeLedgerHead(data) : null
    if (
      extensions.length !== 1 ||
      head === null ||
      !headsMatch(head.head, computeHead(trust.groupID, ledger.map(ledgerEntryDigest)))
    )
      return null
    const entries = []
    for (const token of ledger) {
      const verified = await verifyRecoveryToken<LedgerEntry>(token, group.context)
      if (
        !isVerifiedToken(verified) ||
        verified.payload.groupID !== trust.groupID ||
        typeof verified.payload.type !== 'string' ||
        typeof verified.payload.subject !== 'string' ||
        (verified.payload.ord !== undefined && typeof verified.payload.ord !== 'string')
      )
        return null
      const { iss, ...entry } = verified.payload
      entries.push({
        entryID: ledgerEntryDigest(token),
        verified: { issuer: normalizeDID(iss), entry },
      })
    }
    const folded = foldControl(entries, group.anchor, trust.groupID)
    await assertTrustedRecoverySigner(
      { ...group, signerTree: tree.tree },
      { ...trust, signerTree: tree.tree, registry: folded.registry },
      signer,
      signed.verifiedPublicKey,
    )
    const epoch = Number(info.groupInfo.groupContext.epoch)
    if (!Number.isSafeInteger(epoch) || epoch < request.comparisonEpoch) return null
    const frames = decodeCheckpoints(lineageBytes)
    const lineage = lineageForKey({
      frames,
      publicKey: signed.verifiedPublicKey,
      groupID: trust.groupID,
      genesisHash: checkpointGenesisHash(trust.genesisAnchor),
      ciphersuite: group.context.cipherSuite.id,
      epoch,
      authHash: checkpointAuthHash({
        groupID: trust.groupID,
        genesisHash: checkpointGenesisHash(trust.genesisAnchor),
        epoch,
        epochAuthenticator: authenticator,
      }),
    })
    if (lineage === null || (lineage[0]?.epoch ?? -1) < request.comparisonEpoch) return null
    return {
      groupID: trust.groupID,
      requesterDID: request.requesterDID,
      requestID,
      epoch,
      captureHead: payload.captureHead,
      groupInfoAuthenticator: authenticator,
      confirmedTranscriptHash: toB64U(info.groupInfo.groupContext.confirmedTranscriptHash),
      responderDID: signer,
      responderKeyHash: checkpointKeyHash(signed.verifiedPublicKey),
      lineage,
      evidence: new Uint8Array(evidence),
    }
  } catch (error) {
    if (
      error instanceof SealedGroupInfoError ||
      error instanceof RecoveryRequestError ||
      error instanceof LeafBindingError
    )
      return null
    throw error
  }
}
