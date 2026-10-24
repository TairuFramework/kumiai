import { createRotate, type SignedEvent, snapshotOf } from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'

import { foldChain } from '../../src/controller-log.js'
import type { EffectClaim } from '../../src/member-root.js'

type RotateChainParams = {
  seed: Uint8Array
  profile: number
  did: string
  chain: Array<SignedEvent>
  deny?: Iterable<string>
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

/** Explicit single-target declarations for chain-only test fixtures. */
export function denyEffects(chain: Array<SignedEvent>, did: string): Array<EffectClaim> {
  const event = chain.find(
    ({ event }) =>
      event.t === 'rot' &&
      'd' in event &&
      (event.d as Array<string> | undefined)?.some(
        (entry) => normalizeDID(entry) === normalizeDID(did),
      ),
  )?.event
  return [
    {
      kind: 'deny',
      did: normalizeDID(did),
      ref: { chainIndex: event == null ? 0 : event.s + (event.g > 0 ? 1 : 0) },
    },
  ]
}
