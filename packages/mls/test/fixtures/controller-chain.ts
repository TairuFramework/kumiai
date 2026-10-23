import {
  authorityPath,
  canonicalBytes,
  createRotate,
  deriveKeyPair,
  type SignedEvent,
  snapshotOf,
} from '@kokuin/controller'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64U } from '@sozai/codec'

import { foldChain } from '../../src/controller-log.js'

type RotateChainParams = {
  seed: Uint8Array
  profile: number
  did: string
  chain: Array<SignedEvent>
  deny?: Iterable<string>
}

export function legacyRevokeChain(
  params: Omit<RotateChainParams, 'deny'> & { subject: string; crit?: boolean },
): SignedEvent {
  const folded = foldChain(params.did, params.chain)
  if (!folded.ok) throw new Error(folded.reason)
  const prior = folded.states.at(-1)
  if (prior == null) throw new Error('Missing controller head')
  const event = {
    v: 1,
    t: 'rev',
    crit: params.crit ?? true,
    i: params.did,
    g: prior.gen,
    s: prior.seq + 1,
    p: prior.digest,
    x: params.subject,
  }
  const key = deriveKeyPair(
    params.seed,
    authorityPath(params.profile, prior.keyGen, prior.keySeq),
    'EdDSA',
  )
  return {
    event,
    sigs: [toB64U(ed25519.sign(canonicalBytes(event), key.privateKey))],
  } as unknown as SignedEvent
}

export function rotateChain(params: RotateChainParams): SignedEvent {
  const folded = foldChain(params.did, params.chain)
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.states.at(-1)
  const prior = params.chain.at(-1)
  if (head == null || prior == null) throw new Error('Missing controller head')
  const snapshot = snapshotOf(head)
  return createRotate({
    seed: params.seed,
    profile: params.profile,
    did: params.did,
    prior: prior.event,
    snapshot: { ...snapshot, deny: [...snapshot.deny, ...(params.deny ?? [])] },
  })
}

export function revokeChain(
  params: Omit<RotateChainParams, 'deny'> & { subject: string },
): SignedEvent {
  return rotateChain({ ...params, deny: [params.subject] })
}

export function snapshotForChain(did: string, chain: Array<SignedEvent>) {
  const folded = foldChain(did, chain)
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.states.at(-1)
  if (head == null) throw new Error('Missing controller head')
  return snapshotOf(head)
}
