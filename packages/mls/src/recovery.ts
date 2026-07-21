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

/** `type` tag on every recovery-request token. Domain-separates it, so a token
 *  minted for another purpose can never pose as a request for group state. */
export const RECOVERY_REQUEST_TYPE = 'kumiai.recovery-request'

/** `type` tag on a responder's GroupInfo attestation. Domain-separates the
 *  membership proof, so no token minted elsewhere can stand in for it. */
export const RECOVERY_GROUPINFO_TYPE = 'kumiai.recovery-groupinfo'

/** The only sealed-reply format this build produces or opens. */
export const SEALED_GROUP_INFO_VERSION = 1

/** The sealed ledger reply shares the frame — `[version][enc][ct]` — and nothing
 *  else: see {@link LEDGER_REPLY}. */
export const SEALED_LEDGER_VERSION = 1

/** X25519 KEM output / public-key length. The only KEM this provider supports, so
 *  `enc` is fixed-width and the sealed frame needs no length prefix. */
const KEM_OUTPUT_LENGTH = 32

/** X25519 secret-key length. Same 32 bytes as the KEM output, but a DISTINCT
 *  invariant: this is the requester's OWN retained key, not a wire field. A wrong
 *  length is a host storage fault (corrupt/truncated own key), not a reply for
 *  someone else, and must NOT be swallowed as {@link openSealedReply}'s benign
 *  `not-for-me` verdict. */
const KEM_PRIVATE_KEY_LENGTH = 32

/** Version byte + `enc` + a bare AEAD tag: the shortest well-formed reply. */
const MIN_SEALED_LENGTH = 1 + KEM_OUTPUT_LENGTH + 16

/**
 * The per-kind labels that keep the two reply kinds — GroupInfo vs ledger —
 * cryptographically non-interchangeable: distinct HPKE `info` AND distinct AAD
 * domain, so a reply of one kind fails to open as the other even when group,
 * member, request id and ephemeral key are all identical. Do not rely on distinct
 * `requestID`s for this separation — that is a caller property a reused id loses;
 * these labels carry it unconditionally.
 */
type SealedReplyKind = {
  /** HPKE `info` — separates this use from MLS's own use of the same ciphersuite,
   *  and from the other reply kind. */
  hpkeInfo: Uint8Array
  /** Prefix of the AAD, before the group/member/request fields are framed in. */
  aadDomain: Uint8Array
  /** The frame's version byte. */
  version: number
  /** Raised when a reply of this kind will not open. */
  fail: (reason: SealedReplyRejection, message: string, options?: ErrorOptions) => Error
}

const GROUP_INFO_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-aad/v1'),
  version: SEALED_GROUP_INFO_VERSION,
  fail: (reason, message, options) => new SealedGroupInfoError(reason, message, options),
}

const LEDGER_REPLY: SealedReplyKind = {
  hpkeInfo: utf8.encode('kumiai/mls/recovery-ledger/v1'),
  aadDomain: utf8.encode('kumiai/mls/recovery-ledger-aad/v1'),
  version: SEALED_LEDGER_VERSION,
  fail: (reason, message, options) => new SealedLedgerError(reason, message, options),
}

/**
 * The signed payload a recovering peer publishes. The requester DID is the signed
 * `iss`, never a self-asserted payload field — nothing to disagree with the
 * signing key. `ephemeralKey` is the only key a reply is ever sealed to (a
 * responder never seals to a key handed in alongside the request), so the
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
 * - `unverified` — token unparseable, unsigned, or signature fails against the DID
 *   it names.
 * - `malformed` — signature verified but payload is not a recovery request (wrong
 *   `type`, missing field, or `ephemeralKey` not a 32-byte X25519 key).
 * - `group-mismatch` — validly signed request for another group. Without this
 *   check a responder in both groups would seal *this* group's state to a request
 *   authorized against another.
 * - `not-a-member` — requester's DID has no leaf in the responder's current
 *   ratchet tree. The authorization check; a removed member fails it.
 */
export type RecoveryRequestRejection =
  | 'unverified'
  | 'malformed'
  | 'group-mismatch'
  | 'not-a-member'

/** Thrown by {@link sealGroupInfo}. The primitive refuses loudly rather than
 *  returning an empty reply; a responder that wants to stay silent catches this. */
export class RecoveryRequestError extends Error {
  #reason: RecoveryRequestRejection

  constructor(reason: RecoveryRequestRejection, message: string, options?: ErrorOptions) {
    super(message, options)
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
 * - `not-for-me` — the AEAD refused: sealed to another ephemeral key, or AAD binds
 *   another member or request. Indistinguishable and all mean "not this peer's".
 *   Never a post-decryption field comparison — the binding is the AAD, so a reply
 *   for someone else never decrypts.
 * - `malformed` — frame truncated or unknown version, or the sealed plaintext is
 *   not a framed `MLSMessage(GroupInfo)`.
 */
export type SealedReplyRejection = 'not-for-me' | 'malformed'

/**
 * Why a requester could not open a sealed GroupInfo — the two shared reasons plus
 * two the AEAD cannot enforce (HPKE base mode authenticates no responder):
 *
 * - `unauthenticated` — no valid proof that a member of the requester's own
 *   last-known group sealed it: missing/unsigned/unverifiable attestation, one that
 *   does not bind this group / request / GroupInfo, or one signed by a DID with no
 *   leaf in the requester's tree.
 * - `group-mismatch` — the offered GroupInfo names a different group id or carries a
 *   different genesis anchor than the group being healed. The anchor is immutable
 *   and the requester holds it, so this is a byte comparison, not a trust decision.
 */
export type SealedGroupInfoRejection = SealedReplyRejection | 'unauthenticated' | 'group-mismatch'

/** Why a requester could not open a sealed ledger — the same two answers. A
 *  GroupInfo presented as a ledger is `not-for-me`, not `malformed`: the domains
 *  differ, so the AEAD refuses before anything is parsed. */
export type SealedLedgerRejection = SealedReplyRejection

/** Thrown by {@link openSealedGroupInfo}. Distinguishes "not addressed to me" from
 *  "corrupt", so a peer sifting a shared lane drops the former quietly. */
export class SealedGroupInfoError extends Error {
  #reason: SealedGroupInfoRejection

  constructor(reason: SealedGroupInfoRejection, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SealedGroupInfoError'
    this.#reason = reason
  }

  get reason(): SealedGroupInfoRejection {
    return this.#reason
  }
}

/** Thrown by {@link openSealedLedger}, read like its GroupInfo sibling: a requester
 *  sifting a shared lane drops `not-for-me` quietly (every other member's reply to
 *  every other request looks like this) and shouts about `malformed`. */
export class SealedLedgerError extends Error {
  #reason: SealedReplyRejection

  constructor(reason: SealedReplyRejection, message: string, options?: ErrorOptions) {
    super(message, options)
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
 * The responder's membership proof, sealed INSIDE the GroupInfo reply. HPKE base
 * mode authenticates nobody, so the AEAD cannot tell a member's reply from an
 * observer's forgery; this token can. Signed by the responder's DID identity key,
 * it binds the group, the request, and a digest of the exact GroupInfo bytes it
 * accompanies. The open side verifies it and requires the signer to hold a leaf in
 * the requester's own last-known tree — the mirror of {@link sealToRequest}'s
 * roster check on the ask direction.
 */
type ResponderAttestation = {
  type: typeof RECOVERY_GROUPINFO_TYPE
  groupID: string
  requestID: string
  /** Multibase-encoded SHA-256 of the framed `MLSMessage(GroupInfo)` this attests. */
  groupInfoDigest: string
}

/** The sealed GroupInfo plaintext: `[len(4)][attestation token][GroupInfo bytes]`,
 *  big-endian length. Proof and vouched-for GroupInfo are sealed under one AEAD;
 *  neither can be lifted from the other. */
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
 * The AAD binding a sealed reply to one kind, group, member, and request. The
 * responder builds it from the *verified* request; the requester rebuilds it from
 * its own handle and request id. Any disagreement is an AEAD failure, not a
 * comparison a caller must remember to make.
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
 * rejected: `verifyToken` returns them unchecked, so their `iss` is
 * attacker-chosen. `embedLongForm` lets it verify offline — a responder needs no
 * DID resolver to answer.
 */
async function verifyRecoveryRequest(token: string): Promise<VerifiedRecoveryRequest> {
  let verified: Awaited<ReturnType<typeof verifyToken<RecoveryRequest>>>
  try {
    verified = await verifyToken<RecoveryRequest>(token)
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new RecoveryRequestError('unverified', 'recovery request signature did not verify', {
      cause,
    })
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
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new RecoveryRequestError('malformed', 'recovery request ephemeral key is not multibase', {
      cause,
    })
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
  /** Correlation id, minted per recover() call. Not authorization — the signature
   *  and the responder's roster check carry that. */
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
 * half. One keypair per request: the private half is what makes the reply openable
 * by this peer and nobody else — an attacker who stole the peer's DID identity key
 * can forge the *request* but cannot read the answer. The keypair is drawn from the
 * group's own ciphersuite HPKE, so no second HPKE enters the system.
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
    // Self-verifying offline: a responder must not need a DID resolver to check
    // the signature of a peer it has never resolved.
    { embedLongForm: true },
  )

  return { request: stringifyToken(signed), ephemeralPublicKey, ephemeralPrivateKey }
}

/**
 * Answer a request of one kind: verify it, check the requester still holds a leaf
 * in the responder's current ratchet tree, and seal `plaintext` to the ephemeral
 * key *inside the signed request*.
 *
 * Authorization is roster-intrinsic and lives HERE, not in each caller, so a new
 * kind of answer cannot be added without it. Not a permission a host can forget:
 * only DIDs the responder's own tree still carries a leaf for can be answered, so a
 * removed member gets nothing from any responder that has applied its removal.
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
 * Open a reply of one kind with the key minted for `requestID`; return the sealed
 * plaintext.
 *
 * The AAD is rebuilt from the caller's *own* group id, DID, and request id, so a
 * reply for another member, another request, or another kind (kind is bound into
 * both AAD and HPKE `info`) fails as an AEAD failure, not a skippable comparison.
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

  // This member's OWN retained key. A wrong length is a corrupt/truncated own key
  // (host storage fault), not a reply for another member, so it must NOT read as
  // `not-for-me` (the benign verdict a lane-sifter drops). Validate OUTSIDE the open,
  // where a throw cannot be mistaken for the AEAD's refusal, and surface a plain
  // Error, not a SealedReplyRejection: a caller/host bug is not a droppable wire
  // condition. (importPrivateKey only wraps the bytes; length is the whole check.)
  if (ephemeralPrivateKey.length !== KEM_PRIVATE_KEY_LENGTH) {
    throw new Error(
      `openSealedReply: retained ephemeral private key must be ${KEM_PRIVATE_KEY_LENGTH} bytes, not ${ephemeralPrivateKey.length} — a corrupt or truncated own key, not a reply for another member`,
    )
  }
  const privateKey = await hpke.importPrivateKey(ephemeralPrivateKey)

  try {
    return await hpke.open(privateKey, enc, ct, kind.hpkeInfo, aad)
  } catch (cause) {
    throw kind.fail('not-for-me', 'sealed reply does not open for this member and request', {
      cause,
    })
  }
}

export type SealGroupInfoParams = {
  /** The responder's current handle. Its ratchet tree — not a roster snapshot or
   *  policy list — is what authorizes the requester. */
  group: GroupHandle
  /** The responder's signing identity: signs the membership attestation and must be
   *  the identity behind `group`'s own leaf. */
  identity: SigningIdentity
  /** The signed request token, verbatim. */
  request: string
}

/**
 * Answer a recovery request with this group's framed `MLSMessage(GroupInfo)`,
 * sealed to the ephemeral key inside the signed request, plus a membership
 * attestation signed with the responder's DID identity key.
 *
 * The attestation is load-bearing: HPKE base mode seals to the requester's public
 * ephemeral key (which rides the public request in the clear), so the AEAD cannot
 * distinguish a member's reply from a forgery. The attestation — bound to this
 * group, request, and a digest of these exact GroupInfo bytes — lets the requester
 * refuse a reply from anyone holding no leaf in its own last-known tree.
 *
 * Throws {@link RecoveryRequestError} for every refusal. The reply is
 * `[version][enc][ct]`, unreadable without the ephemeral private key and opening
 * for no other member, request, or kind.
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
    // Self-verifying offline: the healing peer must check the signature without
    // resolving the responder.
    { embedLongForm: true },
  )

  const plaintext = frameAttestedGroupInfo(stringifyToken(signed), groupInfo)
  return await sealToRequest(GROUP_INFO_REPLY, group, request, plaintext)
}

export type OpenSealedGroupInfoParams = {
  /** The requester's own handle. Supplies the DID and group the AAD is rebuilt from
   *  — a caller has no DID to pass, so cannot open a reply for someone else. */
  group: GroupHandle
  sealed: Uint8Array
  /** The id of the request this reply is expected to answer. */
  requestID: string
  /** The private half retained since {@link createRecoveryRequest}. */
  ephemeralPrivateKey: Uint8Array
}

/**
 * Verify the responder's membership attestation and require the signer to hold a
 * leaf in the requester's own last-known ratchet tree — the authentication the AEAD
 * cannot provide (HPKE base mode proves only that the ephemeral-key holder opened
 * it, never who sealed it).
 *
 * The attestation must bind this group, request, and a digest of these exact
 * GroupInfo bytes, so an honest attestation for one GroupInfo cannot be lifted onto
 * a substituted one. The tree checked against is the requester's OWN — stale by
 * construction, which is the point and the limit: a member absent from it (never
 * joined, or removed before the requester's last-known epoch) is refused; one still
 * in it (including one removed AFTER that epoch) is accepted.
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
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new SealedGroupInfoError(
      'unauthenticated',
      'responder attestation signature did not verify',
      { cause },
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
 * Bind the offered GroupInfo to the group being healed: same group id, same
 * immutable genesis anchor. The anchor is written once at creation and seeds the
 * roster a peer folds, so a byte comparison against the requester's own refuses any
 * group whose authority root differs.
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
 * bytes `joinGroupExternal` takes. Throws {@link SealedGroupInfoError}.
 *
 * Opening is not the end of the check: HPKE base mode proves only that this peer
 * held the ephemeral key, not that a member sealed it. Two further gates make the
 * reply roster-intrinsic before the bytes are handed on — the signed attestation
 * must place the sealer in this requester's own last-known tree, and the offered
 * GroupInfo's group id and genesis anchor must match the group being healed.
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
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new SealedGroupInfoError(
      'malformed',
      'sealed plaintext is not a framed, attested GroupInfo',
      { cause },
    )
  }

  // Parse as a GroupInfo before anything trusts its fields.
  try {
    inspectGroupInfo(groupInfo)
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new SealedGroupInfoError(
      'malformed',
      'sealed plaintext is not a framed MLSMessage(GroupInfo)',
      { cause },
    )
  }

  // Authenticate the responder, then bind the GroupInfo to this group.
  await assertResponderIsMember(attestation, group, requestID, groupInfo)
  assertGroupInfoBoundToGroup(groupInfo, group)

  return groupInfo
}

/**
 * The whole ordered ledger, framed for sealing: `[count(4)][ (length(4) | token)... ]`,
 * big-endian throughout. Order is load-bearing: the head is a chain digest, so the
 * same tokens reordered fold to a different head and the requester rejects them — a
 * list, never a set or map.
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
  // The count and its framed tokens must consume the whole payload. Reject trailing
  // bytes here (same truncated/malformed class): a lax decoder is a parser
  // differential the downstream head check might not catch.
  if (offset !== bytes.length) {
    throw new Error('sealed ledger has trailing bytes after the last token')
  }
  return tokens
}

export type SealLedgerParams = {
  /** The responder's current handle. Its ratchet tree authorizes the requester on
   *  the same terms as {@link sealGroupInfo}, and its own ledger is the only one it
   *  can seal: the payload is read from {@link GroupHandle.getLedger}, never handed
   *  in, so no caller can seal another group's authority state through this. */
  group: GroupHandle
  /** The signed request token, verbatim — the same {@link createRecoveryRequest}
   *  token a GroupInfo request carries. */
  request: string
}

/**
 * Answer a ledger gather: the group's whole ordered authority state, sealed to the
 * ephemeral key inside the signed request.
 *
 * These are the SAME bodies a commit frame seals under the epoch secret, but the
 * rendezvous topic is public and secretless. A reply the hub could open would hand
 * every role change, in order, to anyone who knows the topic; an unauthorized reply
 * would hand them to anyone who can mint a request. {@link sealToRequest}'s roster
 * check closes the second hole and is NOT optional — a seal without it merely
 * encrypts the authority state neatly to the attacker's own key.
 *
 * Epoch-INDEPENDENT, hence HPKE to an ephemeral key and not the epoch secret: the
 * peer most needing a bootstrap may be at an older epoch than every responder, and
 * a reply sealed under the responder's current epoch would be unopenable by it.
 *
 * The ledger sealed is always this handle's own — read from
 * {@link GroupHandle.getLedger} under the mutex — so a responder can only ever seal
 * the authority state of the group whose tree just authorized the requester.
 *
 * Throws {@link RecoveryRequestError} for every refusal; the responder stays silent.
 */
export async function sealLedger(params: SealLedgerParams): Promise<Uint8Array> {
  const { group, request } = params
  const entries = await group.getLedger()
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
 * Opening proves NOTHING about who sealed these tokens: HPKE base mode over an AAD
 * whose fields all ride the public request in the clear, so any observer (the hub, a
 * stranger who learned the topic) can forge a reply that opens as a member's would.
 * The bound is not the seal but the head check the caller runs next —
 * {@link GroupHandle.bootstrapLedger} re-derives every id from the token bytes and
 * gates on the MLS-authenticated `ledger_head`, which a forger cannot reproduce. So a
 * forged or lying reply can withhold, reorder, or truncate — never rewrite — and a
 * forged one simply fails that check. Residual is DoS only (a forged reply can burn a
 * gather attempt), not compromise. Throws {@link SealedLedgerError}.
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
  } catch (cause) {
    // biome-ignore lint/style/useErrorCause: cause IS passed; the rule only reads argument 1, and these take (reason, message, options).
    throw new SealedLedgerError('malformed', 'sealed plaintext is not a framed ledger', {
      cause,
    })
  }
}
