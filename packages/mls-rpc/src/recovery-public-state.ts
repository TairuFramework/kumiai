import type { ClientState } from '@kumiai/mls'
import {
  clientStateDecoder,
  clientStateEncoder,
  decode,
  defaultExtensionTypes,
  encode,
  groupStateEncoder,
  mlsMessageDecoder,
  wireformats,
} from 'ts-mls'

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
