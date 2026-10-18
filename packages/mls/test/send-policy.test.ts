import { randomIdentity } from '@kokuin/token'
import { describe, expect, test, vi } from 'vitest'

import { deriveGroup } from '../src/group-handle.js'
import * as mls from '../src/index.js'
import {
  ApplicationSendRefusedError,
  bindSendCeiling,
  CommitValidationUnavailableError,
  createGroup,
  decodeClientState,
  denyApplicationSend,
  encodeClientState,
  type GroupHandle,
  isApplicationSendDenied,
  ownApplicationGeneration,
  relinquishSend,
  reserveApplicationRange,
  restoreGroup,
} from '../src/index.js'
import { createMutex } from '../src/mutex.js'
import { readSenderData, readSenderLeafIndex } from '../src/sender-data.js'
import {
  agent,
  lowLevelWelcome,
  pipelineGroup,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

const payload = new Uint8Array([1])
const range = { floor: 0, size: 16, cap: 500 }
async function fresh() {
  return (await createGroup(randomIdentity(), 'send-policy')).group
}
async function restore(handle: GroupHandle, bytes: Uint8Array) {
  const state = decodeClientState(bytes)
  if (state == null) throw new Error('Invalid test state')
  return restoreGroup({ state, credential: handle.credential, ledgerEntries: handle.ledgerTokens })
}

describe('application send policy', () => {
  test('no policy sends; denied refuses before consuming and cannot be rebound', async () => {
    const handle = await fresh()
    await expect(handle.encrypt(payload)).resolves.toBeInstanceOf(Uint8Array)
    expect(ownApplicationGeneration(handle.state)).toBe(1)
    expect(denyApplicationSend(handle)).toBe(handle)
    denyApplicationSend(handle)
    const before = encodeClientState(handle.state)
    await expect(handle.encrypt(payload)).rejects.toBeInstanceOf(ApplicationSendRefusedError)
    expect(encodeClientState(handle.state)).toEqual(before)
    expect(() => bindSendCeiling(handle, () => 3)).toThrow(TypeError)
    expect(
      Object.keys(mls).filter((name) =>
        /(grant|allow|unrestrict|enable).*send|send.*(grant|allow|unrestrict|enable)/i.test(name),
      ),
    ).toEqual([])
  })

  test('bound limit admits below only, binds once and can be denied', async () => {
    const handle = await fresh()
    let limit = 1
    bindSendCeiling(handle, () => limit)
    expect(() => bindSendCeiling(handle, () => 100)).toThrow(TypeError)
    await handle.encrypt(payload)
    await expect(handle.encryptApplication(payload)).rejects.toBeInstanceOf(
      ApplicationSendRefusedError,
    )
    expect(ownApplicationGeneration(handle.state)).toBe(1)
    limit = 2
    await handle.encrypt(payload)
    denyApplicationSend(handle)
    await expect(handle.encrypt(payload)).rejects.toBeInstanceOf(ApplicationSendRefusedError)
  })

  test.each(['denied', 'bound'] as const)('derived handles of %s handles refuse', async (kind) => {
    const handle = await fresh()
    if (kind === 'denied') denyApplicationSend(handle)
    else bindSendCeiling(handle, () => 100)
    const derived = deriveGroup(handle, structuredClone(handle.state))
    expect(isApplicationSendDenied(derived)).toBe(true)
    await expect(derived.encrypt(payload)).rejects.toBeInstanceOf(ApplicationSendRefusedError)
  })

  test('concurrent encryptApplication reports the wire generation', async () => {
    const handle = await fresh()
    const frames = await Promise.all(
      Array.from({ length: 20 }, () => handle.encryptApplication(payload)),
    )
    expect(frames.map((frame) => frame.generation)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    const before = encodeClientState(handle.state)
    for (const frame of frames) {
      expect(await handle.readSenderData(frame.ciphertext)).toEqual({
        epoch: 0,
        leaf: 0,
        generation: frame.generation,
      })
    }
    expect(encodeClientState(handle.state)).toEqual(before)
  })
})

describe('owned application reservation', () => {
  test('requires denial and persists the advanced generation', async () => {
    const handle = await fresh()
    await expect(reserveApplicationRange(handle, range)).rejects.toThrow(TypeError)
    denyApplicationSend(handle)
    const reserved = await reserveApplicationRange(handle, range)
    expect(reserved).toMatchObject({ start: 0, limit: 16 })
    if (reserved === null) throw new Error('Missing reservation')
    const pre = await restore(handle, reserved.pre)
    const advanced = await restore(handle, reserved.advanced)
    expect((await pre.encryptApplication(payload)).generation).toBe(0)
    expect((await advanced.encryptApplication(payload)).generation).toBe(16)
    await expect(handle.encrypt(payload)).rejects.toBeInstanceOf(ApplicationSendRefusedError)
  })

  test('floor skips to 40 and cap truncates at 500', async () => {
    const handle = denyApplicationSend(await fresh())
    expect(await reserveApplicationRange(handle, { ...range, floor: 40 })).toMatchObject({
      start: 40,
      limit: 56,
    })
    expect(await reserveApplicationRange(handle, { ...range, floor: 490 })).toMatchObject({
      start: 490,
      limit: 500,
    })
    const before = encodeClientState(handle.state)
    expect(await reserveApplicationRange(handle, range)).toBeNull()
    expect(encodeClientState(handle.state)).toEqual(before)
  })

  test('inactive and pending-proposal reservations leave state unchanged', async () => {
    const handle = await fresh()
    handle.state.groupActiveState = { kind: 'removedFromGroup' }
    denyApplicationSend(handle)
    const before = encodeClientState(handle.state)
    await expect(reserveApplicationRange(handle, range)).rejects.toThrow()
    expect(encodeClientState(handle.state)).toEqual(before)
    const pending = await fresh()
    await pending.proposeSelfRemoval()
    denyApplicationSend(pending)
    const proposed = encodeClientState(pending.state)
    await expect(reserveApplicationRange(pending, range)).rejects.toThrow()
    expect(encodeClientState(pending.state)).toEqual(proposed)
  })
})

describe('exclusive send transfer', () => {
  test('waits for an admitted encrypt blocked mid-sign and captures its advanced state', async () => {
    const handle = await fresh()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const sign = handle.context.cipherSuite.signature.sign
    vi.spyOn(handle.context.cipherSuite.signature, 'sign').mockImplementation(async (...args) => {
      entered.resolve()
      await release.promise
      return sign(...args)
    })
    try {
      const encrypt = handle.encryptApplication(payload)
      await entered.promise
      let settled = false
      const transfer = relinquishSend(handle).then((value) => {
        settled = true
        return value
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve()
      expect((await encrypt).generation).toBe(0)
      const captured = await transfer
      const privateHandle = denyApplicationSend(await restore(handle, captured.state))
      expect(await reserveApplicationRange(privateHandle, range)).toMatchObject({
        start: 1,
        limit: 17,
      })
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('does not invoke a mutating method on the supplied object', async () => {
    const handle = await fresh()
    const calls: Array<PropertyKey> = []
    const proxy = new Proxy(handle, {
      get(target, key) {
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        return (...args: Array<unknown>) => {
          calls.push(key)
          return value.apply(target, args)
        }
      },
    })
    await relinquishSend(proxy)
    expect(calls).toEqual([])
  })
})

test('sender data keeps the leaf-only 4-byte minimum and requires 8 bytes for generation', async () => {
  const handle = await fresh()
  const pm = {
    groupId: new Uint8Array(),
    epoch: 0n,
    contentType: 1,
    ciphertext: new Uint8Array(),
    encryptedSenderData: new Uint8Array(),
    authenticatedData: new Uint8Array(),
  }
  const secret = handle.state.keySchedule.senderDataSecret
  const decrypt = vi.spyOn(handle.context.cipherSuite.hpke, 'decryptAead')
  try {
    decrypt.mockResolvedValue(new Uint8Array([0, 0, 0, 7]))
    expect(await readSenderLeafIndex(handle.context, secret, pm)).toBe(7)
    expect(await readSenderData(handle.context, secret, pm)).toBeNull()
    decrypt.mockRejectedValue(new Error('missing key'))
    await expect(readSenderData(handle.context, secret, pm)).rejects.toBeInstanceOf(
      CommitValidationUnavailableError,
    )
    expect(await handle.readSenderData(new Uint8Array([1, 2, 3]))).toBeNull()
  } finally {
    vi.restoreAllMocks()
  }
})

test('lapsed reservations refuse without advancing', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  try {
    const setup = await pipelineGroup()
    const peer = agent(61)
    const { author: group } = await lowLevelWelcome(
      setup.group,
      peer,
      await timedBinding({ identity: peer, iat: 201, exp: 300 }),
    )
    denyApplicationSend(group)
    const before = encodeClientState(group.state)
    await expect(reserveApplicationRange(group, range)).rejects.toThrow(mls.LeafLapsedError)
    expect(encodeClientState(group.state)).toEqual(before)
  } finally {
    vi.restoreAllMocks()
  }
})

test('manual acquisition and run share a FIFO queue and release is idempotent', async () => {
  const mutex = createMutex()
  const release = await mutex.acquire()
  const order: Array<number> = []
  const run = mutex.run(async () => {
    order.push(1)
    throw new Error('failure')
  })
  const rejection = expect(run).rejects.toThrow('failure')
  const acquired = mutex.acquire().then((unlock) => {
    order.push(2)
    unlock()
  })
  const tail = mutex.run(async () => {
    order.push(3)
  })
  await Promise.resolve()
  expect(order).toEqual([])
  release()
  release()
  await Promise.all([rejection, acquired, tail])
  expect(order).toEqual([1, 2, 3])
})
