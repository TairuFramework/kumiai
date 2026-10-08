import type { GenerationSecret, SecretTree } from 'ts-mls'

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
