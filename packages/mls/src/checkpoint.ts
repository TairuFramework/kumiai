import { ed25519 } from '@noble/curves/ed25519.js'
import { fromB64U } from '@sozai/codec'

import {
  checkpointSignatureInput,
  decodeEpochCheckpoint,
  decodeEpochRosterFact,
} from './checkpoint-codec.js'
import type {
  CheckpointComparison,
  EpochCheckpointBodyV1,
  EpochRosterFactV1,
} from './checkpoint-types.js'

function sameBinding(body: EpochCheckpointBodyV1, fact: EpochRosterFactV1): boolean {
  return (
    body.groupID === fact.key.groupID &&
    body.genesisHash === fact.genesisHash &&
    body.ciphersuite === fact.ciphersuite &&
    body.epoch === fact.epoch
  )
}

/** Results rely on the caller independently authenticating its retained local facts. */
export async function verifyCheckpointPair(params: {
  first: Uint8Array
  second: Uint8Array
  localRosterFact: Uint8Array
  eligibilityRosterFact?: Uint8Array
}): Promise<CheckpointComparison> {
  try {
    const first = decodeEpochCheckpoint(params.first)
    const second = decodeEpochCheckpoint(params.second)
    if (params.localRosterFact.length === 0) return { kind: 'coverage-gap' }
    const fact = decodeEpochRosterFact(params.localRosterFact)
    if (!sameBinding(first.body, fact) || !sameBinding(second.body, fact))
      return { kind: 'invalid' }
    const eligibility =
      params.eligibilityRosterFact == null
        ? fact
        : decodeEpochRosterFact(params.eligibilityRosterFact)
    if (
      eligibility !== fact &&
      (eligibility.key.groupID !== fact.key.groupID ||
        eligibility.key.incarnation !== fact.key.incarnation ||
        eligibility.genesisHash !== fact.genesisHash ||
        eligibility.ciphersuite !== fact.ciphersuite ||
        eligibility.epoch !== fact.epoch - 1)
    )
      return { kind: 'invalid' }
    const signers = [first, second].map(({ body }) => {
      return eligibility.members.filter((member) => member.keyHash === body.keyHash)
    })
    if (signers.some((members) => members.length > 1)) return { kind: 'invalid' }
    if (signers.some((members) => members.length === 0)) return { kind: 'coverage-gap' }
    for (const [index, frame] of [first, second].entries()) {
      const member = signers[index]?.[0]
      if (
        member == null ||
        !ed25519.verify(
          frame.signature,
          checkpointSignatureInput(frame.body),
          fromB64U(member.signaturePublicKey),
          { zip215: false },
        )
      )
        return { kind: 'invalid' }
    }
    if (first.body.authHash !== fact.authHash && second.body.authHash !== fact.authHash)
      return { kind: 'coverage-gap' }
    const remote = first.body.authHash === fact.authHash ? second.body : first.body
    const signer = eligibility.members.find((member) => member.keyHash === remote.keyHash)
    if (signer == null) return { kind: 'coverage-gap' }
    const identity = { epoch: fact.epoch, signerDID: signer.signerDID, keyHash: remote.keyHash }
    return first.body.authHash === second.body.authHash
      ? { kind: 'agreement', ...identity }
      : {
          kind: 'conflict',
          ...identity,
          localAuthHash: fact.authHash,
          remoteAuthHash: remote.authHash,
          parentAuthHash: remote.parentAuthHash,
        }
  } catch {
    return { kind: 'invalid' }
  }
}
