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

import { exportGroupInfo, type GroupHandle, inspectGroupInfo } from './group.js'

const utf8 = new TextEncoder()

/** The `type` tag every recovery-request token carries. Domain-separates the
 *  token from every other signed payload in the stack, so a token minted for
 *  another purpose can never be presented as a request for group state. */
export const RECOVERY_REQUEST_TYPE = 'group.recovery-request'

/** The only sealed-reply format this build produces or opens. */
export const SEALED_GROUP_INFO_VERSION = 1

/**
 * Bound into the AAD of every sealed reply, then framed field by field. The
 * domain separator keeps the AAD from colliding with any other length-framed
 * byte string in the group (e.g. the ledger head's chain), and both sides build
 * it with the same function — a byte-identical AAD is a correctness requirement
 * here, not a nicety.
 */
const AAD_DOMAIN = utf8.encode('kumiai/mls/recovery-aad/v1')

/** HPKE `info` for the sealed reply — separates this use of the group's HPKE
 *  from every use MLS itself makes of the same ciphersuite. */
const HPKE_INFO = utf8.encode('kumiai/mls/recovery/v1')

/** X25519 KEM output / public key length. The only KEM the crypto provider
 *  supports (see `createNobleCryptoProvider`), so `enc` is fixed-width and the
 *  sealed frame needs no length prefix. */
const KEM_OUTPUT_LENGTH = 32

/** Version byte + `enc` + a bare AEAD tag: the shortest well-formed reply. */
const MIN_SEALED_LENGTH = 1 + KEM_OUTPUT_LENGTH + 16

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
export type SealedGroupInfoRejection = 'not-for-me' | 'malformed'

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

/**
 * The AAD binding a sealed reply to one group, one member, and one request. The
 * responder builds it from the *verified* request; the requester rebuilds it
 * from its own handle and its own request id. Any disagreement — a reply meant
 * for another member, or for another request by the same member — is an AEAD
 * failure, not something a caller has to remember to compare.
 */
function recoveryAAD(groupID: string, requesterDID: string, requestID: string): Uint8Array {
  return concat([
    AAD_DOMAIN,
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

export type SealGroupInfoParams = {
  /** The responder's current handle. Its ratchet tree — not a roster snapshot,
   *  not a policy list — is what authorizes the requester. */
  group: GroupHandle
  /** The signed request token, verbatim. */
  request: string
}

/**
 * Answer a recovery request: verify it, check the requester still has a leaf in
 * the responder's current ratchet tree, and seal this group's framed
 * `MLSMessage(GroupInfo)` to the ephemeral key *inside the signed request*.
 *
 * Authorization is roster-intrinsic. It is not a permission a host can forget to
 * check: the only DIDs that can be answered are the ones the responder's own MLS
 * tree still carries a leaf for, so a removed member gets nothing from the first
 * responder that has applied its removal.
 *
 * Throws {@link RecoveryRequestError} for every refusal — see
 * {@link RecoveryRequestRejection}. The reply is `[version][enc][ct]`; nothing
 * in it is readable without the ephemeral private key, and nothing in it opens
 * for another member or another request.
 */
export async function sealGroupInfo(params: SealGroupInfoParams): Promise<Uint8Array> {
  const { group, request } = params
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

  const { groupInfo } = await exportGroupInfo({ group })
  const { hpke } = group.context.cipherSuite
  const aad = recoveryAAD(group.groupID, verified.requesterDID, verified.requestID)
  const { ct, enc } = await hpke.seal(
    await hpke.importPublicKey(verified.ephemeralPublicKey),
    groupInfo,
    HPKE_INFO,
    aad,
  )

  const sealed = new Uint8Array(1 + enc.length + ct.length)
  sealed[0] = SEALED_GROUP_INFO_VERSION
  sealed.set(enc, 1)
  sealed.set(ct, 1 + enc.length)
  return sealed
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
 * Open a sealed reply and return the framed `MLSMessage(GroupInfo)` — the exact
 * bytes `joinGroupExternal` takes, unchanged.
 *
 * The AAD is rebuilt from the caller's *own* group id and DID and the request id
 * it names, so a reply minted for another member, or for another request by this
 * same member, fails as an AEAD failure rather than a field comparison a caller
 * could skip. Throws {@link SealedGroupInfoError}.
 */
export async function openSealedGroupInfo(params: OpenSealedGroupInfoParams): Promise<Uint8Array> {
  const { group, sealed, requestID, ephemeralPrivateKey } = params

  if (sealed.length < MIN_SEALED_LENGTH || sealed[0] !== SEALED_GROUP_INFO_VERSION) {
    throw new SealedGroupInfoError('malformed', 'sealed GroupInfo frame is truncated or unknown')
  }
  const enc = sealed.slice(1, 1 + KEM_OUTPUT_LENGTH)
  const ct = sealed.slice(1 + KEM_OUTPUT_LENGTH)

  const { hpke } = group.context.cipherSuite
  const aad = recoveryAAD(group.groupID, group.credential.id, requestID)

  let groupInfo: Uint8Array
  try {
    groupInfo = await hpke.open(
      await hpke.importPrivateKey(ephemeralPrivateKey),
      enc,
      ct,
      HPKE_INFO,
      aad,
    )
  } catch {
    throw new SealedGroupInfoError(
      'not-for-me',
      'sealed GroupInfo does not open for this member and request',
    )
  }

  // The AEAD proves a group member sealed these bytes for this request; it does
  // not prove they framed a GroupInfo. Fail here rather than deep inside a join.
  try {
    inspectGroupInfo(groupInfo)
  } catch {
    throw new SealedGroupInfoError(
      'malformed',
      'sealed plaintext is not a framed MLSMessage(GroupInfo)',
    )
  }
  return groupInfo
}
