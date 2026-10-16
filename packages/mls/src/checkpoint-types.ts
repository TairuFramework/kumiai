export type CheckpointKey = { groupID: string; incarnation: number }

export type EpochCheckpointBodyV1 = {
  v: 1
  type: 'kumiai/checkpoint/v1'
  groupID: string
  genesisHash: string
  ciphersuite: number
  epoch: number
  authHash: string
  parentAuthHash: string | null
  keyHash: string
  leafIndex: number
}

export type CheckpointMember = {
  signerDID: string
  keyHash: string
  leafIndex: number
  signaturePublicKey: string
}

export type EpochRosterFactV1 = {
  v: 1
  key: CheckpointKey
  genesisHash: string
  ciphersuite: number
  epoch: number
  authHash: string
  parentAuthHash: string | null
  confirmedTranscriptHash: string
  members: Array<CheckpointMember>
  installation: { mutationID: string; stateVersion: number }
}

export type CheckpointComparison =
  | { kind: 'agreement'; epoch: number; signerDID: string; keyHash: string }
  | {
      kind: 'conflict'
      epoch: number
      signerDID: string
      keyHash: string
      localAuthHash: string
      remoteAuthHash: string
      parentAuthHash: string | null
    }
  | { kind: 'invalid' | 'coverage-gap' }
