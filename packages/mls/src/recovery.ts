import {
  decodeMultibase,
  encodeMultibase,
  isVerifiedToken,
  normalizeDID,
  type SignedPayload,
  type SigningIdentity,
  stringifyToken,
  verifyToken,
} from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'

import { readGroupAnchorExtension } from './anchor.js'
import {
  exportGroupInfo,
  type GroupHandle,
  inspectGroupInfo,
  readGroupInfoBinding,
} from './group.js'

const utf8 = new TextEncoder()

/** The `type` tag every recovery-request token carries. Domain-separates the
 *  token from every other signed payload in the stack, so a token minted for
 *  another purpose can never be presented as a request for group state. */
export const RECOVERY_REQUEST_TYPE = 'group.recovery-request'

/** The `type` tag a responder's GroupInfo attestation carries. Domain-separates
 *  the responder's membership proof from every other signed payload, so a token
 *  minted elsewhere can never stand in for it. */
export const RECOVERY_GROUPINFO_TYPE = 'group.recovery-groupinfo'

/** The only sealed-reply format this build produces or opens. */
export const SEALED_GROUP_INFO_VERSION = 1

/** The sealed ledger reply shares the frame — `[version][enc][ct]` — and shares
 *  nothing else: see {@link LEDGER_REPLY}. */
export const SEALED_LEDGER_VERSION = 1

/** X25519 KEM output / public key length. The only KEM the crypto provider
 *  supports (see `createNobleCryptoProvider`), so `enc` is fixed-width and the
 *  sealed frame needs no length prefix. */
const KEM_OUTPUT_LENGTH = 32

/** Version byte + `enc` + a bare AEAD tag: the shortest well-formed reply. */
const MIN_SEALED_LENGTH = 1 + KEM_OUTPUT_LENGTH + 16

/**
 * What a sealed reply CARRIES, as the AEAD sees it. One rendezvous answers two
 * different questions — "give me the group's state" and "give me the group's
 * ledger" — and the two answers must not be interchangeable: a responder's reply
 * to one must be undecryptable as the other, so no peer can be fed a ledger where
 * it asked for a GroupInfo or the reverse.
 *
 * The separation is cryptographic and unconditional. In practice a peer's two
 * gathers already carry different `requestID`s, so their AADs already differ —
 * but that is a property of the caller, not of the seal, and a caller that reused
 * an id would silently lose the distinction. The labels below are what actually
 * carry it: distinct HPKE `info` AND a distinct AAD domain, so the two replies
 * fail to open for each other even when the group, the member, the request id and
 * the ephemeral key are all identical.
 */
type SealedReplyKind = {
  /** HPKE `info` — separates this use of the group's HPKE from every use MLS
   *  itself makes of the same ciphersuite, and from the other reply kind. */
  hpkeInfo: Uint8Array
  /** Prefix of the AAD, before the group/member/request fields are framed in. */
  aadDomain: Uint8Array
  /** The frame's version byte. */
  version: number
  /** Raised when a reply of this kind will not open. */
  fail: (reason: SealedReplyRejection, message: string) => Error
}

const GROUP_INFO_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-aad/v1'),
  version: SEALED_GROUP_INFO_VERSION,
  fail: (reason, message) => new SealedGroupInfoError(reason, message),
}

const LEDGER_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery-ledger/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-ledger-aad/v1'),
  version: SEALED_LEDGER_VERSION,
  fail: (reason, message) => new SealedLedgerError(reason, message),
}

/**
 * The signed payload a recovering peer publishes. `iss` — filled by the signer,
 * covered by the signature — is the requester's DID: the request has no
 * self-asserted DID field, so there is nothing to disagree with the key that
 * signed it.
 *
 * `ephemeralKey` is the multibase-encoded public half of an HPKE keypair minted
 * for this one request. It is the *only* key a reply is ever sealed to: a
 * responder never seals to a key handed to it alongside the request, so the
 * signature covers the key that matters.
 */
export type RecoveryRequest = {
  type: typeof RECOVERY_REQUEST_TYPE
  groupID: string
  requestID: string
  /** Multibase-encoded X25519 public key, minted per request. */
  ephemeralKey: string
}

/** A recovery request whose signature verified and whose fields parsed. */
export type VerifiedRecoveryRequest = {
  /** The authenticated issuer of the request token, normalized. */
  requesterDID: string
  groupID: string
  requestID: string
  ephemeralPublicKey: Uint8Array
}

/**
 * Why a responder refused a request.
 *
 * - `unverified` — the token is unparseable, unsigned, or its signature does not
 *   verify against the DID it names. Cryptographic.
 * - `malformed` — the signature verified but the payload is not a recovery
 *   request (wrong `type`, missing field, or an `ephemeralKey` that is not a
 *   32-byte X25519 key). A comparison in code.
 * - `group-mismatch` — a validly signed request for another group. A comparison
 *   in code: without it, a responder that is a member of both groups would seal
 *   *this* group's state to a request authorized against another.
 * - `not-a-member` — the requester's DID has no leaf in the responder's current
 *   ratchet tree. A comparison in code over MLS state — the authorization check,
 *   and the one a removed member fails.
 */
export type RecoveryRequestRejection =
  | 'unverified'
  | 'malformed'
  | 'group-mismatch'
  | 'not-a-member'

/** Thrown by {@link sealGroupInfo}. A responder that wants to stay silent rather
 *  than answer catches this and returns nothing; the primitive itself refuses
 *  loudly, so a caller cannot mistake a refusal for an empty reply. */
export class RecoveryRequestError extends Error {
  #reason: RecoveryRequestRejection

  constructor(reason: RecoveryRequestRejection, message: string) {
    super(message)
    this.name = 'RecoveryRequestError'
    this.#reason = reason
  }

  get reason(): RecoveryRequestRejection {
    return this.#reason
  }
}

/**
 * Why a requester could not open a reply.
 *
 * - `not-for-me` — the AEAD refused. Either the reply was sealed to another
 *   ephemeral key, or its AAD binds another member or another request. The two
 *   are cryptographically indistinguishable and both mean the same thing: these
 *   bytes are not this peer's rescue. Never a field comparison after decryption
 *   — the binding is the AAD, so a reply for someone else never decrypts at all.
 * - `malformed` — the frame is truncated or carries an unknown version, or the
 *   plaintext a responder sealed is not a framed `MLSMessage(GroupInfo)`.
 */
export type SealedReplyRejection = 'not-for-me' | 'malformed'

/**
 * Why a requester could not open a sealed GroupInfo — the two shared reasons plus
 * two the GroupInfo reply carries that the AEAD alone cannot enforce, because HPKE
 * base mode authenticates no responder:
 *
 * - `unauthenticated` — the reply carried no valid proof that a member of the
 *   requester's own last-known group sealed it: a missing, unsigned, or unverifiable
 *   responder attestation, one that does not bind this group / request / GroupInfo,
 *   or one signed by a DID that holds no leaf in the requester's ratchet tree.
 * - `group-mismatch` — the offered GroupInfo names a different group id, or carries
 *   a different genesis anchor, than the group being healed. The anchor is immutable
 *   for the group's whole life and the requester already holds it, so this is a
 *   byte comparison, not a trust decision.
 */
export type SealedGroupInfoRejection = SealedReplyRejection | 'unauthenticated' | 'group-mismatch'

/** Why a requester could not open a sealed ledger. The same two answers, for the
 *  same two reasons — and a GroupInfo presented as a ledger is `not-for-me`, not
 *  `malformed`: the domains differ, so the AEAD refuses before anything is parsed. */
export type SealedLedgerRejection = SealedReplyRejection

/** Thrown by {@link openSealedGroupInfo}. Distinguishes "not addressed to me"
 *  from "corrupt", so a peer sifting replies off a shared lane can drop the
 *  former quietly and shout about the latter. */
export class SealedGroupInfoError extends Error {
  #reason: SealedGroupInfoRejection

  constructor(reason: SealedGroupInfoRejection, message: string) {
    super(message)
    this.name = 'SealedGroupInfoError'
    this.#reason = reason
  }

  get reason(): SealedGroupInfoRejection {
    return this.#reason
  }
}

/** Thrown by {@link openSealedLedger}, and read exactly as its GroupInfo sibling
 *  is: a requester sifting replies off a shared lane drops `not-for-me` quietly —
 *  every other member's reply to every other request looks like this — and shouts
 *  about `malformed`. */
export class SealedLedgerError extends Error {
  #reason: SealedReplyRejection

  constructor(reason: SealedReplyRejection, message: string) {
    super(message)
    this.name = 'SealedLedgerError'
    this.#reason = reason
  }

  get reason(): SealedReplyRejection {
    return this.#reason
  }
}

/** 4-byte big-endian length prefix before a field's UTF-8 bytes, so no two
 *  distinct field triples can encode to the same AAD. */
function frameField(value: string): Uint8Array {
  const bytes = utf8.encode(value)
  const framed = new Uint8Array(4 + bytes.length)
  new DataView(framed.buffer).setUint32(0, bytes.length, false)
  framed.set(bytes, 4)
  return framed
}

function concat(parts: Array<Uint8Array>): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * The responder's membership proof, carried INSIDE the sealed GroupInfo reply. HPKE
 * base mode seals to a public key and authenticates nobody, so the AEAD alone cannot
 * tell a member's reply from an observer's forgery. This token can: it is signed by
 * the responder's DID identity key and binds the group, the request it answers, and
 * a digest of the exact GroupInfo bytes it accompanies. The open side verifies the
 * signature and then requires the signer to hold a leaf in the requester's own
 * last-known ratchet tree — the mirror of the roster check {@link sealToRequest}
 * makes on the ask direction.
 */
type ResponderAttestation = {
  type: typeof RECOVERY_GROUPINFO_TYPE
  groupID: string
  requestID: string
  /** Multibase-encoded SHA-256 of the framed `MLSMessage(GroupInfo)` this attests. */
  groupInfoDigest: string
}

/** The sealed GroupInfo plaintext: `[len(4)][attestation token][GroupInfo bytes]`,
 *  big-endian length, so the responder's proof and the GroupInfo it vouches for are
 *  sealed together under one AEAD and neither can be lifted from the other. */
function frameAttestedGroupInfo(attestation: string, groupInfo: Uint8Array): Uint8Array {
  const token = utf8.encode(attestation)
  const out = new Uint8Array(4 + token.length + groupInfo.length)
  new DataView(out.buffer).setUint32(0, token.length, false)
  out.set(token, 4)
  out.set(groupInfo, 4 + token.length)
  return out
}

function unframeAttestedGroupInfo(bytes: Uint8Array): {
  attestation: string
  groupInfo: Uint8Array
} {
  if (bytes.length < 4) throw new Error('attested GroupInfo frame is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = view.getUint32(0, false)
  if (4 + length > bytes.length) throw new Error('attested GroupInfo frame is truncated')
  return {
    attestation: new TextDecoder().decode(bytes.subarray(4, 4 + length)),
    groupInfo: bytes.slice(4 + length),
  }
}

/**
 * The AAD binding a sealed reply to one KIND of answer, one group, one member,
 * and one request. The responder builds it from the *verified* request; the
 * requester rebuilds it from its own handle and its own request id. Any
 * disagreement — a reply meant for another member, for another request by the
 * same member, or answering another question entirely — is an AEAD failure, not
 * something a caller has to remember to compare.
 */
function recoveryAAD(
  kind: SealedReplyKind,
  groupID: string,
  requesterDID: string,
  requestID: string,
): Uint8Array {
  return concat([
    kind.aadDomain,
    frameField(groupID),
    frameField(normalizeDID(requesterDID)),
    frameField(requestID),
  ])
}

/**
 * Verify a request token's signature and parse its payload. The requester DID is
 * the verified issuer, never a payload field. Unsigned (`alg: 'none'`) tokens are
 * rejected: `verifyToken` returns them without checking a signature, so their
 * `iss` is attacker-chosen — same discipline as `verifyLedgerEntry`.
 *
 * Like a ledger entry, a request is signed with `embedLongForm`, so it verifies
 * offline against nothing but itself: a responder needs no DID resolver to answer.
 */
async function verifyRecoveryRequest(token: string): Promise<VerifiedRecoveryRequest> {
  let verified: Awaited<ReturnType<typeof verifyToken<RecoveryRequest>>>
  try {
    verified = await verifyToken<RecoveryRequest>(token)
  } catch {
    throw new RecoveryRequestError('unverified', 'recovery request signature did not verify')
  }
  if (!isVerifiedToken<SignedPayload & RecoveryRequest>(verified)) {
    throw new RecoveryRequestError('unverified', 'recovery request is not signed')
  }

  const { iss, type, groupID, requestID, ephemeralKey } = verified.payload
  if (
    type !== RECOVERY_REQUEST_TYPE ||
    typeof groupID !== 'string' ||
    typeof requestID !== 'string' ||
    typeof ephemeralKey !== 'string'
  ) {
    throw new RecoveryRequestError('malformed', 'recovery request payload is malformed')
  }

  let ephemeralPublicKey: Uint8Array
  try {
    ephemeralPublicKey = decodeMultibase(ephemeralKey)
  } catch {
    throw new RecoveryRequestError('malformed', 'recovery request ephemeral key is not multibase')
  }
  if (ephemeralPublicKey.length !== KEM_OUTPUT_LENGTH) {
    throw new RecoveryRequestError(
      'malformed',
      `recovery request ephemeral key must be ${KEM_OUTPUT_LENGTH} bytes`,
    )
  }

  return { requesterDID: normalizeDID(iss), groupID, requestID, ephemeralPublicKey }
}

export type CreateRecoveryRequestParams = {
  /** The requester's own (possibly stale) handle: it names the group, and its
   *  ciphersuite is the HPKE the ephemeral keypair must be minted under. */
  group: GroupHandle
  identity: SigningIdentity
  /** Correlation id, minted per recover() call. Not an authorization token — the
   *  signature and the responder's roster check carry authorization. */
  requestID: string
}

export type CreateRecoveryRequestResult = {
  /** The signed request token, verbatim wire form. */
  request: string
  ephemeralPublicKey: Uint8Array
  /** Retained by the host, keyed by `requestID`, until the reply is opened. The
   *  caller owns its lifetime: nothing here zeroes it. */
  ephemeralPrivateKey: Uint8Array
}

/**
 * Mint an ephemeral HPKE keypair and sign the request that publishes its public
 * half. One keypair per request: the private half is what makes the reply
 * openable by this peer and nobody else — including an attacker holding a stolen
 * copy of the peer's DID identity key, who can forge the *request* but cannot
 * read the answer.
 *
 * The keypair is drawn from the group's own ciphersuite HPKE, so no second HPKE
 * enters the system.
 */
export async function createRecoveryRequest(
  params: CreateRecoveryRequestParams,
): Promise<CreateRecoveryRequestResult> {
  const { group, identity, requestID } = params
  if (normalizeDID(identity.id) !== normalizeDID(group.credential.id)) {
    throw new Error(
      `createRecoveryRequest: identity.id (${identity.id}) must match the handle credential (${group.credential.id})`,
    )
  }

  const { hpke } = group.context.cipherSuite
  const keyPair = await hpke.generateKeyPair()
  const ephemeralPublicKey = await hpke.exportPublicKey(keyPair.publicKey)
  const ephemeralPrivateKey = await hpke.exportPrivateKey(keyPair.privateKey)

  const signed = await identity.signToken<RecoveryRequest>(
    {
      type: RECOVERY_REQUEST_TYPE,
      groupID: group.groupID,
      requestID,
      ephemeralKey: encodeMultibase(ephemeralPublicKey),
    },
    // Self-verifying offline, like a ledger entry: a responder answering a peer
    // it has never resolved must not need a DID resolver to check the signature.
    { embedLongForm: true },
  )

  return { request: stringifyToken(signed), ephemeralPublicKey, ephemeralPrivateKey }
}

/**
 * Answer a request of one kind: verify the request, check the requester still has
 * a leaf in the responder's current ratchet tree, and seal `plaintext` to the
 * ephemeral key *inside the signed request*.
 *
 * Authorization is roster-intrinsic, and it lives HERE rather than in each caller
 * — every answer this rendezvous can give is bound by the same tree lookup, and a
 * new kind of answer cannot be added without it. It is not a permission a host can
 * forget to check: the only DIDs that can be answered are the ones the responder's
 * own MLS tree still carries a leaf for, so a removed member gets nothing from the
 * first responder that has applied its removal.
 *
 * Throws {@link RecoveryRequestError} for every refusal — see
 * {@link RecoveryRequestRejection}.
 */
async function sealToRequest(
  kind: SealedReplyKind,
  group: GroupHandle,
  request: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const verified = await verifyRecoveryRequest(request)

  if (verified.groupID !== group.groupID) {
    throw new RecoveryRequestError(
      'group-mismatch',
      `recovery request names group ${verified.groupID}, not ${group.groupID}`,
    )
  }
  if (group.findMemberLeafIndex(verified.requesterDID) === undefined) {
    throw new RecoveryRequestError(
      'not-a-member',
      `recovery requester ${verified.requesterDID} has no leaf in the current ratchet tree`,
    )
  }

  const { hpke } = group.context.cipherSuite
  const aad = recoveryAAD(kind, group.groupID, verified.requesterDID, verified.requestID)
  const { ct, enc } = await hpke.seal(
    await hpke.importPublicKey(verified.ephemeralPublicKey),
    plaintext,
    kind.hpkeInfo,
    aad,
  )

  const sealed = new Uint8Array(1 + enc.length + ct.length)
  sealed[0] = kind.version
  sealed.set(enc, 1)
  sealed.set(ct, 1 + enc.length)
  return sealed
}

/**
 * Open a reply of one kind with the key minted for `requestID`, and return the
 * plaintext the responder sealed.
 *
 * The AAD is rebuilt from the caller's *own* group id and DID and the request id
 * it names, so a reply minted for another member, or for another request by this
 * same member, fails as an AEAD failure rather than a field comparison a caller
 * could skip. So does a reply answering another question: the kind is bound into
 * the AAD and the HPKE `info`, and neither is negotiable.
 */
async function openSealedReply(
  kind: SealedReplyKind,
  group: GroupHandle,
  sealed: Uint8Array,
  requestID: string,
  ephemeralPrivateKey: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length < MIN_SEALED_LENGTH || sealed[0] !== kind.version) {
    throw kind.fail('malformed', 'sealed reply frame is truncated or carries an unknown version')
  }
  const enc = sealed.slice(1, 1 + KEM_OUTPUT_LENGTH)
  const ct = sealed.slice(1 + KEM_OUTPUT_LENGTH)

  const { hpke } = group.context.cipherSuite
  const aad = recoveryAAD(kind, group.groupID, group.credential.id, requestID)

  try {
    return await hpke.open(
      await hpke.importPrivateKey(ephemeralPrivateKey),
      enc,
      ct,
      kind.hpkeInfo,
      aad,
    )
  } catch {
    throw kind.fail('not-for-me', 'sealed reply does not open for this member and request')
  }
}

export type SealGroupInfoParams = {
  /** The responder's current handle. Its ratchet tree — not a roster snapshot,
   *  not a policy list — is what authorizes the requester. */
  group: GroupHandle
  /** The responder's own signing identity. It signs the membership attestation the
   *  requester checks, and must be the identity behind `group`'s own leaf. */
  identity: SigningIdentity
  /** The signed request token, verbatim. */
  request: string
}

/**
 * Answer a recovery request with this group's framed `MLSMessage(GroupInfo)`,
 * sealed to the ephemeral key inside the signed request and accompanied by a
 * membership attestation the responder signs with its DID identity key.
 *
 * The attestation is not decoration. The seal is HPKE base mode — it needs only
 * the requester's public ephemeral key, every input to which rides the public
 * request in the clear — so the AEAD cannot distinguish a member's reply from an
 * observer's forgery. The signed attestation, bound to this group, this request,
 * and a digest of these exact GroupInfo bytes, is what lets the requester refuse a
 * reply from anyone who does not hold a leaf in its own last-known tree.
 *
 * Throws {@link RecoveryRequestError} for every refusal of the request itself. The
 * reply is `[version][enc][ct]`; nothing in it is readable without the ephemeral
 * private key, and nothing in it opens for another member, another request, or
 * another kind of answer.
 */
export async function sealGroupInfo(params: SealGroupInfoParams): Promise<Uint8Array> {
  const { group, identity, request } = params
  if (normalizeDID(identity.id) !== normalizeDID(group.credential.id)) {
    throw new Error(
      `sealGroupInfo: identity.id (${identity.id}) must match the responding handle credential (${group.credential.id})`,
    )
  }

  const verified = await verifyRecoveryRequest(request)
  const { groupInfo } = await exportGroupInfo({ group })

  const signed = await identity.signToken<ResponderAttestation>(
    {
      type: RECOVERY_GROUPINFO_TYPE,
      groupID: verified.groupID,
      requestID: verified.requestID,
      groupInfoDigest: encodeMultibase(sha256(groupInfo)),
    },
    // Self-verifying offline, like the request and every ledger entry: the healing
    // peer must be able to check the signature without resolving the responder.
    { embedLongForm: true },
  )

  const plaintext = frameAttestedGroupInfo(stringifyToken(signed), groupInfo)
  return await sealToRequest(GROUP_INFO_REPLY, group, request, plaintext)
}

export type OpenSealedGroupInfoParams = {
  /** The requester's own handle. Supplies the DID and group the AAD is rebuilt
   *  from, so a caller cannot open a reply addressed to somebody else by passing
   *  the wrong DID — it has no DID to pass. */
  group: GroupHandle
  sealed: Uint8Array
  /** The id of the request this reply is expected to answer. */
  requestID: string
  /** The private half retained since {@link createRecoveryRequest}. */
  ephemeralPrivateKey: Uint8Array
}

/**
 * Verify the responder's membership attestation and require the signer to hold a
 * leaf in the requester's own last-known ratchet tree. This is the authentication
 * the AEAD cannot provide: HPKE base mode seals to a public key, so opening proves
 * only that the holder of the ephemeral private key opened it — never who sealed it.
 *
 * The attestation must bind this group, this request, and a digest of these exact
 * GroupInfo bytes, so a member cannot have its honest attestation for one GroupInfo
 * lifted onto a substituted one. The tree it is checked against is the requester's
 * OWN — stale by construction, which is the point and the limit: a member absent
 * from that tree (never joined, or removed before the requester's last-known epoch)
 * is refused, and a member still in it (including one removed AFTER that epoch) is
 * accepted.
 */
async function assertResponderIsMember(
  attestation: string,
  group: GroupHandle,
  requestID: string,
  groupInfo: Uint8Array,
): Promise<void> {
  let verified: Awaited<ReturnType<typeof verifyToken<ResponderAttestation>>>
  try {
    verified = await verifyToken<ResponderAttestation>(attestation)
  } catch {
    throw new SealedGroupInfoError(
      'unauthenticated',
      'responder attestation signature did not verify',
    )
  }
  if (!isVerifiedToken<SignedPayload & ResponderAttestation>(verified)) {
    throw new SealedGroupInfoError('unauthenticated', 'responder attestation is not signed')
  }

  const { iss, type, groupID, requestID: attestedRequestID, groupInfoDigest } = verified.payload
  if (
    type !== RECOVERY_GROUPINFO_TYPE ||
    groupID !== group.groupID ||
    attestedRequestID !== requestID ||
    typeof groupInfoDigest !== 'string' ||
    groupInfoDigest !== encodeMultibase(sha256(groupInfo))
  ) {
    throw new SealedGroupInfoError(
      'unauthenticated',
      'responder attestation does not bind this group, request, and GroupInfo',
    )
  }
  if (group.findMemberLeafIndex(normalizeDID(iss)) === undefined) {
    throw new SealedGroupInfoError(
      'unauthenticated',
      "responder holds no leaf in the requester's last-known ratchet tree",
    )
  }
}

/**
 * Bind the offered GroupInfo to the group being healed: same group id, and the same
 * immutable genesis anchor the requester already holds. The anchor is written once
 * at creation and never changes, so a byte comparison against the requester's own
 * costs nothing and refuses any group whose authority root differs — the roster a
 * hijacked peer would fold is seeded from that anchor.
 */
function assertGroupInfoBoundToGroup(groupInfo: Uint8Array, group: GroupHandle): void {
  const binding = readGroupInfoBinding(groupInfo)
  if (binding.groupID !== group.groupID) {
    throw new SealedGroupInfoError(
      'group-mismatch',
      `sealed GroupInfo names group ${binding.groupID}, not ${group.groupID}`,
    )
  }
  const ownAnchor = readGroupAnchorExtension(group)
  const ownData = ownAnchor?.extensionData instanceof Uint8Array ? ownAnchor.extensionData : null
  if (
    ownData == null ||
    binding.anchorExtensionData == null ||
    !bytesEqual(ownData, binding.anchorExtensionData)
  ) {
    throw new SealedGroupInfoError(
      'group-mismatch',
      'sealed GroupInfo carries a different genesis anchor than the group being healed',
    )
  }
}

/**
 * Open a sealed reply and return the framed `MLSMessage(GroupInfo)` — the exact
 * bytes `joinGroupExternal` takes, unchanged. Throws {@link SealedGroupInfoError}.
 *
 * Opening the AEAD is not the end of the check. The seal is HPKE base mode, so a
 * reply that opens proves only that this peer held the ephemeral key it minted —
 * not that a member sealed it. Two further gates make the reply roster-intrinsic:
 * the responder's signed attestation must place the sealer in this requester's own
 * last-known tree, and the offered GroupInfo's group id and genesis anchor must
 * match the group being healed. Only then are the bytes handed on.
 */
export async function openSealedGroupInfo(params: OpenSealedGroupInfoParams): Promise<Uint8Array> {
  const { group, sealed, requestID, ephemeralPrivateKey } = params
  const plaintext = await openSealedReply(
    GROUP_INFO_REPLY,
    group,
    sealed,
    requestID,
    ephemeralPrivateKey,
  )

  let attestation: string
  let groupInfo: Uint8Array
  try {
    ;({ attestation, groupInfo } = unframeAttestedGroupInfo(plaintext))
  } catch {
    throw new SealedGroupInfoError(
      'malformed',
      'sealed plaintext is not a framed, attested GroupInfo',
    )
  }

  // Parse as a GroupInfo before anything trusts its fields.
  try {
    inspectGroupInfo(groupInfo)
  } catch {
    throw new SealedGroupInfoError(
      'malformed',
      'sealed plaintext is not a framed MLSMessage(GroupInfo)',
    )
  }

  // Authenticate the responder, then bind the GroupInfo to this group.
  await assertResponderIsMember(attestation, group, requestID, groupInfo)
  assertGroupInfoBoundToGroup(groupInfo, group)

  return groupInfo
}

/**
 * The whole ordered ledger, framed for sealing: `[count(4)][ (length(4) | token)... ]`,
 * big-endian throughout, to match the AAD's framing rather than the wire codecs'.
 *
 * The ORDER is what is being carried, and it is load-bearing: the head is a chain
 * digest, so the same tokens in another order fold to another head and the
 * requester rejects them. A list is the only faithful shape — not a set, not a map.
 */
function encodeLedgerTokens(tokens: Array<string>): Uint8Array {
  const encoded = tokens.map((token) => utf8.encode(token))
  const size = encoded.reduce((total, bytes) => total + 4 + bytes.length, 4)
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  view.setUint32(0, encoded.length, false)
  let offset = 4
  for (const bytes of encoded) {
    view.setUint32(offset, bytes.length, false)
    out.set(bytes, offset + 4)
    offset += 4 + bytes.length
  }
  return out
}

function decodeLedgerTokens(bytes: Uint8Array): Array<string> {
  if (bytes.length < 4) throw new Error('sealed ledger is too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(0, false)
  const tokens: Array<string> = []
  let offset = 4
  for (let i = 0; i < count; i++) {
    if (offset + 4 > bytes.length) throw new Error('sealed ledger is truncated')
    const length = view.getUint32(offset, false)
    const start = offset + 4
    if (start + length > bytes.length) throw new Error('sealed ledger is truncated')
    tokens.push(new TextDecoder().decode(bytes.subarray(start, start + length)))
    offset = start + length
  }
  return tokens
}

export type SealLedgerParams = {
  /** The responder's current handle. Its ratchet tree is what authorizes the
   *  requester, on exactly the terms {@link sealGroupInfo} is authorized. */
  group: GroupHandle
  /** The signed request token, verbatim — the same token a GroupInfo request
   *  carries, and minted by the same {@link createRecoveryRequest}. */
  request: string
  /** The whole ordered ledger this responder holds, as signed tokens. */
  entries: Array<string>
}

/**
 * Answer a ledger gather: the group's whole ordered authority state, sealed to the
 * ephemeral key inside the signed request.
 *
 * These are the SAME bodies a commit frame seals under the epoch secret, and the
 * gather must give the relay no more than the commit lane does. It gives it less:
 * the rendezvous topic is public and secretless, so a reply the hub could open
 * would hand every role, promotion and demotion, in order, to anyone who knows the
 * topic — and an UNAUTHORIZED reply would hand them to anyone who can mint a
 * request. The roster check inside {@link sealToRequest} is what closes the second
 * hole, and it is not optional: a seal without it merely encrypts the group's
 * authority state neatly to the attacker's own key.
 *
 * The seal is epoch-INDEPENDENT, and that is why it is HPKE to an ephemeral key
 * and not the epoch secret: the peer that most needs a bootstrap is one that
 * crashed between its rejoin and its gather, and it may be at an older epoch than
 * every responder. A reply sealed under the responder's current epoch would be
 * unopenable by the very peer that asked for it.
 *
 * Throws {@link RecoveryRequestError} for every refusal; the responder stays silent.
 */
export async function sealLedger(params: SealLedgerParams): Promise<Uint8Array> {
  const { group, request, entries } = params
  return await sealToRequest(LEDGER_REPLY, group, request, encodeLedgerTokens(entries))
}

export type OpenSealedLedgerParams = {
  /** The requester's own handle: the DID and group the AAD is rebuilt from. */
  group: GroupHandle
  sealed: Uint8Array
  /** The id of the request this reply is expected to answer. */
  requestID: string
  /** The private half retained since {@link createRecoveryRequest}. */
  ephemeralPrivateKey: Uint8Array
}

/**
 * Open a sealed ledger reply and return the responder's whole ordered ledger, as
 * signed tokens.
 *
 * Opening proves NOTHING about who sealed these tokens. The seal is HPKE base mode
 * over an AAD whose every field rides the public request in the clear, so an observer
 * of the request — the hub, a stranger who learned the topic — can forge a reply that
 * opens just as a member can. The bound this path rests on is not the seal but the
 * head check the caller runs next: {@link GroupHandle.bootstrapLedger} re-derives every
 * id from the token bytes and gates on the MLS-authenticated `ledger_head`, which a
 * forger cannot reproduce. So a forged or lying reply can withhold, reorder or
 * truncate — never rewrite — and a genuinely forged one simply fails that check and is
 * dropped. (The residual is a denial of service: a forged reply that opens can burn a
 * requester's gather attempt. It is not a compromise.) Throws {@link SealedLedgerError}.
 */
export async function openSealedLedger(params: OpenSealedLedgerParams): Promise<Array<string>> {
  const { group, sealed, requestID, ephemeralPrivateKey } = params
  const plaintext = await openSealedReply(
    LEDGER_REPLY,
    group,
    sealed,
    requestID,
    ephemeralPrivateKey,
  )
  try {
    return decodeLedgerTokens(plaintext)
  } catch {
    throw new SealedLedgerError('malformed', 'sealed plaintext is not a framed ledger')
  }
}
