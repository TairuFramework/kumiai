import {
  type ClientState,
  clientStateDecoder,
  clientStateEncoder,
  encode,
  type RatchetTree,
} from 'ts-mls'

export type { ClientState }

// V1 cannot distinguish absent proposal senders from sender zero and cannot be migrated.
const CLIENT_STATE_VERSION = 2

export function decodeClientState(encoded: Uint8Array): ClientState | undefined {
  if (encoded.length === 0) return undefined
  // Unsupported versions remain distinguishable from malformed storage.
  if (encoded[0] !== CLIENT_STATE_VERSION) {
    throw new Error(`decodeClientState: unsupported client-state version ${encoded[0]}`)
  }
  const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
  let offset = 1
  const readLength = () => {
    if (encoded.length - offset < 4) return undefined
    const length = view.getUint32(offset, false)
    offset += 4
    return length
  }
  const bodyLength = readLength()
  if (bodyLength === undefined || bodyLength > encoded.length - offset - 4) return undefined
  // ts-mls secrets are views; even Buffer inputs must be copied before ratcheting zeroes them.
  const bodyCopy = new Uint8Array(encoded.subarray(offset, offset + bodyLength))
  offset += bodyLength
  const refCount = readLength()
  if (refCount === undefined || refCount > Math.floor((encoded.length - offset) / 4)) {
    return undefined
  }
  try {
    const result = clientStateDecoder(bodyCopy, 0)
    if (result === undefined || result[1] !== bodyCopy.length) return undefined
    const state = result[0]
    const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    let previousRef: string | undefined
    for (let index = 0; index < refCount; index++) {
      const refLength = readLength()
      if (refLength === undefined || refLength > encoded.length - offset) return undefined
      const ref = textDecoder.decode(encoded.subarray(offset, offset + refLength))
      offset += refLength
      if (previousRef !== undefined && ref <= previousRef) return undefined
      if (!Object.hasOwn(state.unappliedProposals, ref)) return undefined
      const proposal = state.unappliedProposals[ref]
      if (proposal === undefined || proposal.senderLeafIndex !== undefined) return undefined
      proposal.senderLeafIndex = 0
      previousRef = ref
    }
    return offset === encoded.length ? state : undefined
  } catch {
    return undefined
  }
}

export function encodeClientState(state: ClientState): Uint8Array {
  const body = encode(clientStateEncoder, state)
  // rc.13 optionalEncoder drops numeric zero; preserve only exact zero senders separately.
  const textEncoder = new TextEncoder()
  const refs = Object.keys(state.unappliedProposals)
    .filter((ref) => state.unappliedProposals[ref]?.senderLeafIndex === 0)
    .sort()
    .map((ref) => textEncoder.encode(ref))
  const out = new Uint8Array(
    9 + body.length + refs.reduce((length, ref) => length + 4 + ref.length, 0),
  )
  const view = new DataView(out.buffer)
  out[0] = CLIENT_STATE_VERSION
  view.setUint32(1, body.length, false)
  out.set(body, 5)
  view.setUint32(5 + body.length, refs.length, false)
  let offset = 9 + body.length
  for (const ref of refs) {
    view.setUint32(offset, ref.length, false)
    out.set(ref, offset + 4)
    offset += 4 + ref.length
  }
  return out
}

export function sanitizeRatchetTree(tree: ReadonlyArray<unknown>): RatchetTree {
  return tree.map((node) => (node == null ? undefined : node)) as RatchetTree
}
