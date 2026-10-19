import { readMessageAAD } from '@kumiai/mls'
import {
  AppFrameStorageError,
  decodeAppAAD,
  FrameEpochError,
  type GroupCrypto,
  GroupSafetyHeldError,
  InvalidAppEntryError,
} from '@kumiai/rpc'

import {
  assertCryptoSafety,
  assertDurableCryptoSafety,
  createGroupCryptoBase,
  type RegistryGroupCryptoParams,
} from './crypto.js'
import {
  MAX_OPEN_BATCH_FRAMES,
  type OpenAppInput,
  type OpenAppResult,
  type PendingAppFrames,
} from './persistence-types.js'

export function createRegistryGroupCrypto(params: RegistryGroupCryptoParams): GroupCrypto & {
  pending: PendingAppFrames
  unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>>
} {
  const { access } = params
  const base = createGroupCryptoBase(params)

  async function unwrapBatch(frames: Array<OpenAppInput>): Promise<Array<OpenAppResult>> {
    assertDurableCryptoSafety(access)
    if (frames.length > MAX_OPEN_BATCH_FRAMES) throw new RangeError('App batch exceeds 64 frames')
    try {
      return await access.openBatch(frames)
    } catch (error) {
      if (error instanceof GroupSafetyHeldError) throw error
      throw new AppFrameStorageError('handle access failed during durable open', { cause: error })
    }
  }

  return {
    ...base,
    wrap: async (bytes, opts) => {
      assertCryptoSafety(access)
      const aad = opts?.aad ?? new Uint8Array()
      return (await access.seal(bytes, { aad, intent: decodeAppAAD(aad)?.intent ?? 'ephemeral' }))
        .ciphertext
    },
    pending: access.pending,
    unwrapBatch,
    unwrap: async (bytes, opts) => {
      if (opts?.frame == null) {
        assertCryptoSafety(access)
        const [result] = await access.receive([
          {
            ciphertext: bytes,
            expectedAAD: opts?.expectedAAD ?? readMessageAAD(bytes) ?? new Uint8Array(),
          },
        ])
        if (result == null) throw new Error('unwrap: invalid app frame')
        if (result.kind === 'opened') {
          const { payload, senderDID, handleEpoch } = result
          if (senderDID == null) {
            throw new Error('unwrap: opened frame has no authenticated sender')
          }
          return { payload, senderDID, epoch: handleEpoch }
        }
        if (result.reason === 'past-epoch' || result.reason === 'future-epoch') {
          throw new FrameEpochError(result.frameEpoch, result.handleEpoch)
        }
        if (result.reason === 'invalid') {
          throw result.error ?? new Error('unwrap: invalid app frame')
        }
        throw new Error(`unwrap: app frame refused (${result.reason})`)
      }
      const results = await unwrapBatch([
        {
          frame: { ...access.key, ...opts.frame },
          ciphertext: bytes,
          expectedAAD: opts.expectedAAD,
        },
      ])
      const [result] = results
      if (results.length !== 1 || result == null) {
        throw new AppFrameStorageError('unwrap: openBatch must return exactly one result')
      }
      if (result.kind === 'opened') {
        const { payload, senderDID } = result.record
        return { payload, senderDID, epoch: result.handleEpoch }
      }
      if (result.reason === 'past-epoch' || result.reason === 'future-epoch') {
        throw new FrameEpochError(result.frameEpoch, result.handleEpoch)
      }
      if (result.reason === 'malformed-plaintext') {
        throw new InvalidAppEntryError('unwrap: malformed app event plaintext')
      }
      throw new Error(`unwrap: app frame refused (${result.reason})`)
    },
  }
}
