/** The only control-envelope version this build interprets. */
export const CONTROL_ENVELOPE_VERSION = 1

const utf8Encode = new TextEncoder()
const utf8Decode = new TextDecoder()

/** Cleartext on the wire; authenticated by the AEAD AAD and the FramedContent signature. */
export type ControlEnvelope = {
  /** Unknown version ⇒ reject the commit. A client that cannot interpret
   *  authority-bearing data must not accept a commit that depends on it. */
  v: 1
  /** Content-addressed ids of the control-ledger entries this commit enacts, in
   *  fold order. Every entry is admin-issued and covered by `ledger_head`.
   *  Absent when the commit writes no ledger entries. */
  entries?: Array<string>
  /** Opaque consumer payload. Never verified, never ordered, never chained.
   *  A JSON value, not bytes — the container is already JSON, so a byte field
   *  would be base64 in JSON. `unknown`, not `any`: the library must not be
   *  able to read it by accident. */
  app?: unknown
}

/**
 * The outcome of decoding arbitrary `authenticatedData`. A rejection is a value,
 * not a throw: the commit policy asks "valid or not" without a try/catch, because
 * "this commit carries a control envelope I cannot interpret" is a normal outcome
 * that maps to *reject the commit*, not a crash. `reason` is for logging, not
 * control flow.
 */
export type DecodeResult = { ok: true; envelope: ControlEnvelope } | { ok: false; reason: string }

/**
 * Serialize an envelope to the bytes that ride in a commit's `authenticatedData`.
 * JSON, matching the ledger-head container's discipline. Absent `entries`/`app`
 * emit no key — an encode of `{ v: 1 }` carries neither `"entries"` nor `"app"`.
 * These bytes are not byte-compared across peers, so a single canonical byte form
 * is not required; only gratuitous non-determinism (undefined keys) is avoided.
 */
export function encodeControlEnvelope(envelope: ControlEnvelope): Uint8Array {
  const json: { v: 1; entries?: Array<string>; app?: unknown } = { v: envelope.v }
  if (envelope.entries !== undefined) {
    json.entries = envelope.entries
  }
  if (envelope.app !== undefined) {
    json.app = envelope.app
  }
  return utf8Encode.encode(JSON.stringify(json))
}

function isStringArray(value: unknown): value is Array<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/**
 * Decode arbitrary `authenticatedData` bytes. NEVER throws. Returns either a
 * usable envelope or a rejection the commit policy turns into a commit rejection.
 *
 * Zero-length bytes are not an error: an ordinary commit that enacts no ledger
 * entries (a key rotation, an Update, a self-Remove, or a client predating this
 * envelope) carries empty `authenticatedData` and decodes to a bare `{ v: 1 }`.
 * Rejecting it would reject every ordinary commit.
 *
 * Everything else fails closed: non-UTF-8 bytes, malformed JSON, a non-object, a
 * missing or non-`1` `v`, or `entries` present but not an array of strings all
 * become a rejection. Unknown keys are tolerated and dropped.
 */
export function decodeControlEnvelope(bytes: Uint8Array): DecodeResult {
  if (bytes.length === 0) {
    return { ok: true, envelope: { v: CONTROL_ENVELOPE_VERSION } }
  }

  let value: unknown
  try {
    value = JSON.parse(utf8Decode.decode(bytes))
  } catch {
    return { ok: false, reason: 'control envelope is not valid JSON' }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: 'control envelope is not a JSON object' }
  }
  const obj = value as Record<string, unknown>

  if (obj.v !== CONTROL_ENVELOPE_VERSION) {
    return { ok: false, reason: `unsupported control envelope version: ${String(obj.v)}` }
  }

  const envelope: ControlEnvelope = { v: CONTROL_ENVELOPE_VERSION }

  if ('entries' in obj) {
    if (!isStringArray(obj.entries)) {
      return { ok: false, reason: 'control envelope entries is not an array of strings' }
    }
    envelope.entries = obj.entries
  }

  if ('app' in obj) {
    envelope.app = obj.app
  }

  return { ok: true, envelope }
}
