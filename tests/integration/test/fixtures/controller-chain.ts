import { createRotate, foldLog, type SignedEvent, snapshotOf } from '@kokuin/controller'

export async function revokeChain(params: {
  seed: Uint8Array
  profile: number
  did: string
  chain: Array<SignedEvent>
  subject: string
}): Promise<SignedEvent> {
  const folded = await foldLog({ did: params.did, input: { chain: params.chain, events: [] } })
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.states.at(-1)
  const prior = params.chain.at(-1)
  if (head == null || prior == null) throw new Error('Missing controller head')
  return await createRotate({
    seed: params.seed,
    profile: params.profile,
    did: params.did,
    prior: prior.event,
    snapshot: { ...snapshotOf({ state: head }), deny: [...head.deny, params.subject] },
  })
}
