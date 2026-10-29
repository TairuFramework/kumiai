import { createRotate, type SignedEvent, snapshotOf } from '@kokuin/controller'

import { foldChain } from '../../../../packages/mls/src/controller-log.js'

export function revokeChain(params: {
  seed: Uint8Array
  profile: number
  did: string
  chain: Array<SignedEvent>
  subject: string
}): SignedEvent {
  const folded = foldChain(params.did, params.chain)
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.states.at(-1)
  const prior = params.chain.at(-1)
  if (head == null || prior == null) throw new Error('Missing controller head')
  return createRotate({
    seed: params.seed,
    profile: params.profile,
    did: params.did,
    prior: prior.event,
    snapshot: { ...snapshotOf(head), deny: [...head.deny, params.subject] },
  })
}
