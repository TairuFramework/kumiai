import * as mls from '@kumiai/mls'
import { decode, mlsMessageDecoder, wireformats } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { alternateWireWelcome } from './fixtures/registry-welcome.js'

test('alternate Welcome really joins', async () => {
  const processWelcome = mls.processWelcome
  const bundles: Array<mls.KeyPackageBundle> = []
  const snapshots: Array<mls.KeyPackageBundle> = []
  const joined: Array<mls.GroupHandle> = []
  const spy = vi.spyOn(mls, 'processWelcome').mockImplementation(async (params) => {
    bundles.push(params.keyPackageBundle)
    snapshots.push(structuredClone(params.keyPackageBundle))
    const result = await processWelcome(params)
    joined.push(result.group)
    return result
  })
  try {
    const { original, alternate, exact, alternateHandle } = await alternateWireWelcome()
    const originalMessage = decode(mlsMessageDecoder, original)
    const alternateMessage = decode(mlsMessageDecoder, alternate)
    if (
      originalMessage?.wireformat !== wireformats.mls_welcome ||
      alternateMessage?.wireformat !== wireformats.mls_welcome
    ) {
      throw new Error('expected two framed Welcomes')
    }
    expect(originalMessage.welcome.secrets).toHaveLength(2)
    expect(alternateMessage.welcome.secrets).toHaveLength(2)
    expect(alternate).not.toEqual(original)
    expect(alternateMessage.welcome.encryptedGroupInfo).toEqual(
      originalMessage.welcome.encryptedGroupInfo,
    )
    expect(alternateMessage.welcome.secrets).toEqual([...originalMessage.welcome.secrets].reverse())
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0]?.[0].welcome).toEqual(original)
    expect(spy.mock.calls[1]?.[0].welcome).toEqual(alternate)
    expect(joined[0]).toBe(exact)
    expect(joined[1]).toBe(alternateHandle)
    expect(alternateHandle).not.toBe(exact)
    expect(alternateHandle.state).not.toBe(exact.state)
    expect(alternateHandle.groupID).toBe(exact.groupID)
    expect(alternateHandle.epoch).toBe(exact.epoch)
    expect(alternateHandle.state.keySchedule.epochAuthenticator).toEqual(
      exact.state.keySchedule.epochAuthenticator,
    )
    expect(bundles[0]).toBe(bundles[1])
    expect(snapshots[1]).toEqual(snapshots[0])
    expect(bundles[0]).toEqual(snapshots[0])
  } finally {
    spy.mockRestore()
  }
})
