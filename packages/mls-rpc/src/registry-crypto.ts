import {
  AppFrameStorageError,
  FrameEpochError,
  type GroupCrypto,
  GroupSafetyHeldError,
  InvalidAppEntryError,
} from '@kumiai/rpc'

import {
  assertCryptoSafety,
  createGroupCryptoBase,
  type RegistryGroupCryptoParams,
} from './crypto.js'
import type { OpenAppInput, OpenAppResult, PendingAppFrames } from './persistence-types.js'

export function createRegistryGroupCrypto(params: RegistryGroupCryptoParams): GroupCrypto & {
  pending: PendingAppFrames
  unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
} {
  const { access } = params
  const base = createGroupCryptoBase(params)

  async function unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>> {
    assertCryptoSafety(access)
    try {
      return await access.openBatch(frames)
    } catch (error) {
      if (error instanceof GroupSafetyHeldError || error instanceof RangeError) throw error
      throw new AppFrameStorageError('handle access failed during durable open', { cause: error })
    }
  }

  return {
    ...base,
    pending: access.pending,
    unwrapBatch,
    unwrap: async (bytes, opts) => {
      assertCryptoSafety(access)
      if (opts?.frame == null) return base.unwrap(bytes, opts)
      const [result] = await unwrapBatch([
        {
          frame: { ...access.key, ...opts.frame },
          ciphertext: bytes,
          expectedAAD: opts.expectedAAD,
        },
      ])
      if (result?.kind === 'opened') {
        const { payload, senderDID, epoch } = result.record
        return { payload, senderDID, epoch }
      }
      if (result?.reason === 'past-epoch' || result?.reason === 'future-epoch') {
        throw new FrameEpochError(result.frameEpoch, result.handleEpoch)
      }
      if (result?.reason === 'malformed-plaintext') {
        throw new InvalidAppEntryError('unwrap: malformed app event plaintext')
      }
      throw new Error(`unwrap: app frame refused (${result?.reason})`)
    },
  }
}
