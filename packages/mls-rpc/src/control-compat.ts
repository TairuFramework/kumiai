import { type ClientState, encodeClientState } from '@kumiai/mls'
import { clientStateEncoder, encode } from 'ts-mls'

import { sameStoredValue } from './memory-incarnation-stores.js'

export function ownHandshakeGeneration(state: ClientState): number {
  return state.secretTree.leafNodes[2 * state.privatePath.leafIndex]?.handshake.generation ?? 0
}

function projectedState(state: ClientState): ClientState {
  return {
    ...state,
    secretTree: {
      leafWidth: state.secretTree.leafWidth,
      intermediateNodes: {},
      leafNodes: {
        [2 * state.privatePath.leafIndex]: {
          handshake: {
            secret: new Uint8Array(),
            generation: ownHandshakeGeneration(state),
            unusedGenerations: {},
          },
          application: { secret: new Uint8Array(), generation: 0, unusedGenerations: {} },
        },
      },
    },
    unappliedProposals: {},
    historicalReceiverData: new Map(),
  }
}

export function controlProjection(state: ClientState): Uint8Array {
  return encodeClientState(projectedState(state))
}

export function controlCompatible(
  source: ClientState,
  current: ClientState,
  referencedProposals: Array<string> = Object.keys(source.unappliedProposals),
): boolean {
  if (!sameStoredValue(controlProjection(source), controlProjection(current))) return false
  const sourceProposals: ClientState['unappliedProposals'] = {}
  const currentProposals: ClientState['unappliedProposals'] = {}
  for (const ref of referencedProposals) {
    const before = source.unappliedProposals[ref]
    const after = current.unappliedProposals[ref]
    if (
      before === undefined ||
      after === undefined ||
      // optionalEncoder conflates an absent sender with leaf zero.
      before.senderLeafIndex !== after.senderLeafIndex
    )
      return false
    sourceProposals[ref] = before
    currentProposals[ref] = after
  }
  const own = source.privatePath.leafIndex
  if (
    Object.entries(current.unappliedProposals).some(
      ([ref, proposal]) =>
        !Object.hasOwn(source.unappliedProposals, ref) && proposal.senderLeafIndex === own,
    ) ||
    [...current.historicalReceiverData.keys()].some(
      (epoch) => !source.historicalReceiverData.has(epoch),
    )
  )
    return false
  // The public client-state codec embeds proposalWithSenderEncoder.
  const projection = projectedState(source)
  return sameStoredValue(
    encode(clientStateEncoder, { ...projection, unappliedProposals: sourceProposals }),
    encode(clientStateEncoder, { ...projection, unappliedProposals: currentProposals }),
  )
}
