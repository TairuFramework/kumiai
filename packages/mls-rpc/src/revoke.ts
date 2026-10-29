import {
  type EffectClaim,
  type GroupHandle,
  type RevokeBuildResult,
  type RevokeWithProofParams,
  revokeWithProof,
} from '@kumiai/mls'
import {
  digestAppliedCommit,
  type GroupMLS,
  type GroupPeer,
  type GroupProtocolDefinition,
  type HostBuilt,
  type Operation,
  OperationOutcomeError,
  OperationRejectedError,
} from '@kumiai/rpc'

import { groupHandleAccess } from './mls.js'

const proofResults = new Map<
  string,
  (result: Extract<PublishRevokeResult, { status: 'committed' }>) => void
>()

export type RevokeJournalOptions = {
  /** Serialise the candidate together with its ledger. */
  serializeJournal: (derived: GroupHandle) => Promise<Uint8Array> | Uint8Array
}

export type PublishRevokeResult =
  | { status: 'committed'; epoch: number; effects: Array<EffectClaim> }
  | Exclude<RevokeBuildResult, { status: 'built' }>

export type PublishRevokeProofParams<Protocols extends Record<string, GroupProtocolDefinition>> = {
  peer: GroupPeer<Protocols>
  mls: GroupMLS
  input: RevokeWithProofParams
}

/** Host build routing for a durable proof request. */
export async function buildRevokeProofOperation(params: {
  mls: GroupMLS
  group: GroupHandle
  op: Operation
  options: RevokeJournalOptions
}): Promise<HostBuilt> {
  const access = groupHandleAccess.get(params.mls)
  if (access == null) throw new Error('Proof operations require an adapter-created GroupMLS')
  const incarnation = await access.readControl(async ({ source }) => source.key.incarnation)
  return buildRevokeProofOnHandle({
    group: params.group,
    incarnation,
    op: params.op,
    options: params.options,
  })
}

export async function buildRevokeProofOnHandle(params: {
  group: GroupHandle
  incarnation: number
  op: Operation
  options: RevokeJournalOptions
}): Promise<HostBuilt> {
  const body = JSON.parse(new TextDecoder().decode(params.op.body)) as {
    type: string
    input: RevokeWithProofParams
  }
  if (body.type !== 'revoke-proof') throw new OperationRejectedError('Not a proof operation')
  const { group, incarnation } = params
  const priorTokens = new Set(group.ledgerTokens)
  const result = await revokeWithProof(group, body.input)
  if (result.status !== 'built') throw new OperationRejectedError(JSON.stringify(result))
  const { newGroup, commitMessage } = result.result
  const journal = await params.options.serializeJournal(newGroup)
  proofResults.get(params.op.id)?.({
    status: 'committed',
    epoch: Number(result.result.epoch),
    effects: result.effects,
  })
  return {
    commit: commitMessage,
    bodies: newGroup.ledgerTokens.filter((token) => !priorTokens.has(token)),
    journal,
    welcome: null,
    epoch: Number(group.epoch),
    authenticatorBefore: group.state.keySchedule.epochAuthenticator.slice(),
    incarnation,
    digest: digestAppliedCommit(commitMessage),
  }
}

export async function publishRevokeProof<Protocols extends Record<string, GroupProtocolDefinition>>(
  params: PublishRevokeProofParams<Protocols>,
): Promise<PublishRevokeResult> {
  if (!groupHandleAccess.has(params.mls)) {
    throw new Error('publishRevokeProof requires an adapter-created GroupMLS')
  }
  const id = crypto.randomUUID()
  let result: Extract<PublishRevokeResult, { status: 'committed' }> | undefined
  proofResults.set(id, (built) => {
    result = built
  })
  try {
    await params.peer.commit({
      id,
      kind: 'ledger',
      revokes: true,
      body: new TextEncoder().encode(JSON.stringify({ type: 'revoke-proof', input: params.input })),
    })
  } catch (error) {
    if (!(error instanceof OperationOutcomeError) || error.outcome.kind !== 'rejected') throw error
    const result = JSON.parse(error.outcome.reason) as Exclude<
      RevokeBuildResult,
      { status: 'built' }
    >
    if (!['already-revoked', 'self-affected', 'not-provable'].includes(result.status)) throw error
    return result
  } finally {
    proofResults.delete(id)
  }
  if (result === undefined) throw new Error('Committed proof operation has no build result')
  return result
}
