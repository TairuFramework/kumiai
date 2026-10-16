import {
  type ClientState,
  readRecoveryPublicTree,
  verifyRecoveryPublicGroupInfo,
} from '@kumiai/mls'
import {
  type CiphersuiteImpl,
  clientStateEncoder,
  decode,
  encode,
  groupStateEncoder,
  type MlsGroupInfo,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'

// Public authentication is shared with request-bound former-member observations.
export async function verifyOfferedGroupInfo(
  _state: ClientState,
  message: MlsGroupInfo,
  suite: CiphersuiteImpl,
): Promise<boolean> {
  return await verifyRecoveryPublicGroupInfo(message, suite)
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

export function offeredTree(
  _state: ClientState,
  groupInfo: Uint8Array,
): ClientState['ratchetTree'] {
  const info = decode(mlsMessageDecoder, groupInfo)
  if (info?.wireformat !== wireformats.mls_group_info)
    throw new TypeError('Invalid captured GroupInfo')
  return readRecoveryPublicTree(info).tree
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
