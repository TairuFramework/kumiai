import type { ClientState } from '@kumiai/mls'
import {
  type CiphersuiteImpl,
  clientStateDecoder,
  clientStateEncoder,
  decode,
  defaultExtensionTypes,
  encode,
  groupStateEncoder,
  type MlsGroupInfo,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'

function vector(bytes: Uint8Array): Uint8Array {
  const length = bytes.length
  if (length >= 0x40000000) throw new TypeError('MLS vector too large')
  const width = length < 64 ? 1 : length < 16384 ? 2 : 4
  const encoded = new Uint8Array(width + length)
  if (width === 1) encoded[0] = length
  else if (width === 2) new DataView(encoded.buffer).setUint16(0, length | 0x4000)
  else new DataView(encoded.buffer).setUint32(0, length | 0x80000000)
  encoded.set(bytes, width)
  return encoded
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

// RFC 9420 tree hashes and GroupInfoTBS signatures. ts-mls keeps their encoders private.
export async function verifyOfferedGroupInfo(
  state: ClientState,
  message: MlsGroupInfo,
  suite: CiphersuiteImpl,
): Promise<boolean> {
  const info = message.groupInfo
  let tree: ClientState['ratchetTree']
  let bodies: Array<Uint8Array>
  let signatureKey: Uint8Array
  let signatureInput: Uint8Array
  try {
    if (info.groupContext.cipherSuite !== suite.id) return false
    tree = offeredTree(state, encode(mlsMessageEncoder, message))
    if (
      tree.some((node, index) => node !== undefined && node.nodeType !== (index % 2 === 0 ? 1 : 2))
    )
      return false
    const signer = tree[info.signer * 2]
    if (signer?.nodeType !== 1) return false
    signatureKey = signer.leaf.signaturePublicKey
    // MLSMessage adds two u16 fields. An empty signature adds one vector-length byte.
    const unsigned = encode(mlsMessageEncoder, {
      ...message,
      groupInfo: { ...info, signature: new Uint8Array() },
    }).subarray(4, -1)
    signatureInput = new Uint8Array([
      ...vector(new TextEncoder().encode('MLS 1.0 GroupInfoTBS')),
      ...vector(unsigned),
    ])
    bodies = tree.map((node) => {
      if (node === undefined) return new Uint8Array([0])
      const encoded = publicTreeBytes({ ...state, ratchetTree: [node] }).tree
      const prefix = 1 << ((encoded[0] ?? 0) >>> 6)
      return new Uint8Array([1, ...encoded.subarray(prefix + 2)])
    })
  } catch {
    // Attested tree bytes can trigger arbitrary decoder/shape failures, including InternalError.
    return false
  }
  // Keep crypto implementation failures outside the malformed-input boundary.
  if (!(await suite.signature.verify(signatureKey, signatureInput, info.signature))) return false

  const hash = async (index: number): Promise<Uint8Array> => {
    const body = bodies[index] ?? new Uint8Array([0])
    if (index % 2 === 0) {
      return await suite.hash.digest(new Uint8Array([1, ...uint32(index / 2), ...body]))
    }
    let level = 0
    while (((index >>> level) & 1) === 1) level++
    const left = await hash(index ^ (1 << (level - 1)))
    const right = await hash(index ^ (3 << (level - 1)))
    return await suite.hash.digest(new Uint8Array([2, ...body, ...vector(left), ...vector(right)]))
  }
  const root = 2 ** Math.floor(Math.log2(tree.length)) - 1
  const digest = await hash(root)
  return (
    digest.length === info.groupContext.treeHash.length &&
    digest.every((byte, index) => byte === info.groupContext.treeHash[index])
  )
}

// ts-mls exposes the complete state codecs, but not its tree/leaf codecs. Isolate the
// public tree between the encoded context and the independently encoded private suffix.
export function publicTreeBytes(state: ClientState): {
  context: Uint8Array
  tree: Uint8Array
  suffix: Uint8Array
} {
  const suffix = encode(groupStateEncoder, state)
  const empty = encode(clientStateEncoder, { ...state, ratchetTree: [] })
  const contextLength = empty.length - suffix.length - 1
  const body = encode(clientStateEncoder, state)
  return {
    context: body.subarray(0, contextLength),
    tree: body.subarray(contextLength, body.length - suffix.length),
    suffix,
  }
}

export function offeredTree(state: ClientState, groupInfo: Uint8Array): ClientState['ratchetTree'] {
  const info = decode(mlsMessageDecoder, groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info)
    throw new TypeError('Invalid captured GroupInfo')
  const tree = info.groupInfo.extensions.find(
    (entry) => entry.extensionType === defaultExtensionTypes.ratchet_tree,
  )?.extensionData
  if (!(tree instanceof Uint8Array)) throw new TypeError('Missing captured recovery tree')
  const { context, suffix } = publicTreeBytes(state)
  const bytes = new Uint8Array([...context, ...tree, ...suffix])
  const parsed = clientStateDecoder(bytes, 0)
  if (parsed === undefined || parsed[1] !== bytes.length)
    throw new TypeError('Invalid captured recovery tree')
  return parsed[0].ratchetTree
}

export function leafBytes(
  state: ClientState,
  node: ClientState['ratchetTree'][number],
): Uint8Array {
  if (node?.nodeType !== 1) throw new TypeError('Missing fresh recovery leaf')
  const { tree } = publicTreeBytes({ ...state, ratchetTree: [node] })
  const lengthBytes = 1 << ((tree[0] ?? 0) >>> 6)
  // A one-node tree has one optional-presence byte and one node-type byte.
  return tree.subarray(lengthBytes + 2)
}
