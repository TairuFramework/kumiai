import { expand as hkdfExpand } from '@noble/hashes/hkdf.js'
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js'
import type { GenerationSecret, MlsContext, SecretTree } from 'ts-mls'

import type { ClientState } from './codec.js'
import { expandWithLabel } from './sender-data.js'

// Control preparation must save restore-time skips even without application traffic.
const restoredReservations = new WeakSet<ClientState>()

export function restoredImportedReservation(state: ClientState): boolean {
  return restoredReservations.has(state)
}

function children(node: number): [number, number] {
  let level = 0
  while (((node >> level) & 1) === 1) level++
  if (level === 0) throw new Error('Missing sender leaf secret')
  return [node ^ (1 << (level - 1)), node ^ (3 << (level - 1))]
}

/** Internal constructor/permit preparation. No handle can escape before the skip completes. */
export function clearImportedReservation(state: ClientState, context: MlsContext): void {
  const reservation = state.handshakeReservation
  if (reservation === undefined) return
  restoredReservations.add(state)
  const own = 2 * state.privatePath.leafIndex
  let leaf = state.secretTree.leafNodes[own]
  if (
    reservation.epoch !== state.groupContext.epoch ||
    (leaf?.handshake.generation ?? 0) > reservation.generation
  ) {
    delete state.handshakeReservation
    return
  }
  // Constructors are synchronous. MLS's three HKDF hashes have distinct Nh lengths.
  const size = context.cipherSuite.kdf.size
  const hash = size === 32 ? sha256 : size === 48 ? sha384 : size === 64 ? sha512 : undefined
  if (hash === undefined) throw new Error(`Unsupported MLS KDF size: ${size}`)
  const generated: Array<Uint8Array> = []
  const consumed: Array<Uint8Array> = []
  const derive = (secret: Uint8Array, label: string, labelContext: Uint8Array): Uint8Array => {
    const text = new TextEncoder().encode(`MLS 1.0 ${label}`)
    // These fixed labels and contexts all fit RFC 9420 opaque<V>'s one-byte length form.
    const info = new Uint8Array([
      0,
      size,
      text.length,
      ...text,
      labelContext.length,
      ...labelContext,
    ])
    const result = hkdfExpand(hash, secret, info, size)
    generated.push(result)
    return result
  }
  const intermediateNodes = { ...state.secretTree.intermediateNodes }
  try {
    if (leaf === undefined) {
      let node = 2 ** Math.floor(Math.log2(2 * state.secretTree.leafWidth - 1)) - 1
      while (intermediateNodes[node] === undefined && node !== own) {
        const [left, right] = children(node)
        node = own < node ? left : right
      }
      while (node !== own) {
        const secret = intermediateNodes[node]
        if (secret === undefined) throw new Error('Missing sender leaf secret')
        const [left, right] = children(node)
        intermediateNodes[left] = derive(secret, 'tree', new TextEncoder().encode('left'))
        intermediateNodes[right] = derive(secret, 'tree', new TextEncoder().encode('right'))
        consumed.push(secret)
        delete intermediateNodes[node]
        node = own < node ? left : right
      }
      const secret = intermediateNodes[own]
      if (secret === undefined) throw new Error('Missing sender leaf secret')
      leaf = {
        application: {
          secret: derive(secret, 'application', new Uint8Array()),
          generation: 0,
          unusedGenerations: {},
        },
        handshake: {
          secret: derive(secret, 'handshake', new Uint8Array()),
          generation: 0,
          unusedGenerations: {},
        },
      }
      consumed.push(secret)
      delete intermediateNodes[own]
    }
    let { secret, generation } = leaf.handshake
    while (generation <= reservation.generation) {
      const encoded = new Uint8Array(4)
      new DataView(encoded.buffer).setUint32(0, generation)
      const next = derive(secret, 'secret', encoded)
      consumed.push(secret)
      secret = next
      generation++
    }
    state.secretTree = {
      ...state.secretTree,
      intermediateNodes,
      leafNodes: {
        ...state.secretTree.leafNodes,
        [own]: { ...leaf, handshake: { ...leaf.handshake, secret, generation } },
      },
    }
  } catch (cause) {
    for (const secret of generated) secret.fill(0)
    throw cause
  }
  for (const secret of consumed) secret.fill(0)
  delete state.handshakeReservation
}

/** Combine two same-epoch ratchets, retaining a skipped key only if neither side spent it. */
function mergeGenerationSecrets(a: GenerationSecret, b: GenerationSecret): GenerationSecret {
  const [ahead, behind] = a.generation >= b.generation ? [a, b] : [b, a]
  const unusedGenerations: Record<number, Uint8Array> = {}
  for (const [generationText, secret] of Object.entries(ahead.unusedGenerations)) {
    const generation = Number(generationText)
    if (generation >= behind.generation || Object.hasOwn(behind.unusedGenerations, generation)) {
      unusedGenerations[generation] = secret
    }
  }
  return { ...ahead, unusedGenerations }
}

/** Merge same-epoch trees without mutating inputs. The result takes `leafWidth` from `target`. */
export function mergeReceiveSecretTree(target: SecretTree, source: SecretTree): SecretTree {
  // Each side can expand a different part of the tree. Keep the most-expanded
  // representation of every branch: an ancestor secret must disappear when
  // either side has derived a descendant, or it could derive spent keys again.
  // The descendants include sibling intermediate secrets needed for members
  // who have not sent yet; simply intersecting node maps loses those keys.
  const intermediateNodes: SecretTree['intermediateNodes'] = {
    ...target.intermediateNodes,
    ...source.intermediateNodes,
  }
  const leafNodes: SecretTree['leafNodes'] = { ...target.leafNodes }
  for (const [indexText, node] of Object.entries(source.leafNodes)) {
    const index = Number(indexText)
    const prior = leafNodes[index]
    leafNodes[index] =
      prior == null
        ? node
        : {
            handshake: mergeGenerationSecrets(prior.handshake, node.handshake),
            application: mergeGenerationSecrets(prior.application, node.application),
          }
  }
  const occupied = [...Object.keys(intermediateNodes), ...Object.keys(leafNodes)].map(Number)
  for (const ancestorText of Object.keys(intermediateNodes)) {
    const ancestor = Number(ancestorText)
    let level = 0
    while (((ancestor >> level) & 1) === 1) level++
    const span = 2 ** level - 1
    if (
      occupied.some(
        (node) => node !== ancestor && node >= ancestor - span && node <= ancestor + span,
      )
    ) {
      delete intermediateNodes[ancestor]
    }
  }
  return { leafWidth: target.leafWidth, intermediateNodes, leafNodes }
}

/** RFC 9420 `DeriveTreeSecret(secret, "secret", generation, KDF.Nh)`: one sender-ratchet step. */
function nextRatchetSecret(
  context: MlsContext,
  secret: Uint8Array,
  generation: number,
): Promise<Uint8Array> {
  const encodedGeneration = new Uint8Array(4)
  new DataView(encodedGeneration.buffer).setUint32(0, generation)
  return expandWithLabel(context, secret, 'secret', encodedGeneration, context.cipherSuite.kdf.size)
}

/**
 * Step a member's OWN sending ratchet forward to `target`, the generation its next frame
 * uses, without encrypting anything. Each step is the one ts-mls's `consumeRatchet` takes
 * per sent frame: the secret advances, the generation increments, and `unusedGenerations`
 * is untouched (a sender keeps no skipped keys for itself). Non-mutating; the returned
 * `consumed` are the retired chain secrets, for the caller to zero once it adopts the result.
 * On a throw, the secrets derived so far are zeroed and the input ratchet is left intact.
 */
export async function advanceSendingRatchet(
  context: MlsContext,
  ratchet: GenerationSecret,
  target: number,
): Promise<{ ratchet: GenerationSecret; consumed: Array<Uint8Array> }> {
  const consumed: Array<Uint8Array> = []
  let { secret, generation } = ratchet
  try {
    while (generation < target) {
      consumed.push(secret)
      secret = await nextRatchetSecret(context, secret, generation)
      generation++
    }
  } catch (error) {
    // The input chain secret still belongs to the caller's state; everything derived from
    // it is unreachable once this throws, so wipe it rather than leave it for GC.
    for (const derived of [...consumed.slice(1), secret]) {
      if (derived !== ratchet.secret) derived.fill(0)
    }
    throw error
  }
  return { ratchet: { ...ratchet, secret, generation }, consumed }
}
