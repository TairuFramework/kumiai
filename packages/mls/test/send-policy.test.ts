import { randomIdentity } from '@kokuin/token'
import { describe, expect, test, vi } from 'vitest'

import { createMlsContext } from '../src/group-context.js'
import { deriveGroup, mutexFor } from '../src/group-handle.js'
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
  assertApplicationSend,
  reserveApplicationKernel,
  serializeHandle,
  withReservationLock,
} from '../src/testing.js'
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

  test('last generation reserves [499, 500)', async () => {
    const handle = denyApplicationSend(await fresh())
    expect(await reserveApplicationRange(handle, { ...range, floor: 499 })).toMatchObject({
      start: 499,
      limit: 500,
    })
  })

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0.5])(
    'invalid floor %s refuses before locking',
    async (floor) => {
      const handle = denyApplicationSend(await fresh())
      const before = encodeClientState(handle.state)
      const release = await mutexFor(handle).acquire()
      let outcome: unknown
      const pending = reserveApplicationRange(handle, { ...range, floor }).catch(
        (error: unknown) => {
          outcome = error
        },
      )
      try {
        for (let i = 0; i < 10; i++) await Promise.resolve()
        expect(outcome).toBeInstanceOf(TypeError)
        expect(encodeClientState(handle.state)).toEqual(before)
      } finally {
        release()
        await pending
      }
    },
  )

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
      let encrypted = false
      const encrypt = handle.encryptApplication(payload).then((frame) => {
        encrypted = true
        return frame
      })
      await entered.promise
      let settled = false
      const transfer = relinquishSend(handle).then((value) => {
        expect(encrypted).toBe(true)
        settled = true
        return value
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      release.resolve()
      const admitted = await encrypt
      expect(admitted.generation).toBe(0)
      const captured = await transfer
      const privateHandle = denyApplicationSend(await restore(handle, captured.state))
      const reserved = await reserveApplicationRange(privateHandle, range)
      expect(reserved).toMatchObject({ start: 1, limit: 17 })
      expect(admitted.generation).toBeLessThan(reserved?.start ?? 0)
      await expect(handle.encryptApplication(payload)).rejects.toThrow(ApplicationSendRefusedError)
    } finally {
      vi.restoreAllMocks()
    }
  })

  test('rejects a proxy before reading, denying or capturing anything', async () => {
    const handle = await fresh()
    const calls: Array<PropertyKey> = []
    const before = encodeClientState(handle.state)
    const proxy = new Proxy(handle, {
      get(target, key) {
        calls.push(key)
        const value = Reflect.get(target, key, target)
        if (typeof value !== 'function') return value
        return (...args: Array<unknown>) => {
          calls.push(key)
          return value.apply(target, args)
        }
      },
    })
    await expect(relinquishSend(proxy)).rejects.toThrow(TypeError)
    expect(() => assertApplicationSend(proxy)).toThrow(TypeError)
    expect(() => withReservationLock(proxy, undefined, async () => {})).toThrow(TypeError)
    expect(() => denyApplicationSend(proxy)).toThrow(TypeError)
    expect(() => bindSendCeiling(proxy, () => 1)).toThrow(TypeError)
    const optionReads: Array<PropertyKey> = []
    const options = new Proxy(range, {
      get(target, key, receiver) {
        optionReads.push(key)
        return Reflect.get(target, key, receiver)
      },
    })
    await expect(reserveApplicationRange(proxy, options)).rejects.toThrow(TypeError)
    expect(optionReads).toEqual([])
    expect(calls).toEqual([])
    expect(isApplicationSendDenied(proxy)).toBe(false)
    expect(isApplicationSendDenied(handle)).toBe(false)
    expect(encodeClientState(handle.state)).toEqual(before)
    expect((await handle.encryptApplication(payload)).generation).toBe(0)
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

test('rejects forged handles before reading their state', async () => {
  const handle = Object.create(mls.GroupHandle.prototype) as GroupHandle
  await expect(relinquishSend(handle)).rejects.toThrow(TypeError)
  expect(() => denyApplicationSend(handle)).toThrow(TypeError)
  expect(() => bindSendCeiling(handle, () => 1)).toThrow(TypeError)
  await expect(reserveApplicationRange(handle, range)).rejects.toThrow(TypeError)
  expect(isApplicationSendDenied(handle)).toBe(false)
})

test('testing reservation and encryption never share a generation', async () => {
  const handle = await fresh()
  const [, frame] = await Promise.all([
    handle[reserveApplicationKernel](16),
    handle.encryptApplication(payload),
  ])
  expect(frame.generation).toBe(16)
  expect((await handle.encryptApplication(payload)).generation).toBe(17)
})

test.each([undefined, 100])(
  'receiver opens a reservation gap above 200 with retention override %s',
  async (maximumForwardRatchetSteps) => {
    vi.spyOn(Date, 'now').mockReturnValue(150_000)
    try {
      const setup = await pipelineGroup()
      const peer = agent(62)
      const { author, joined } = await lowLevelWelcome(
        setup.group,
        peer,
        await timedBinding({ identity: peer, iat: 100, exp: 200 }),
      )
      const receiver = await restoreGroup({
        state: joined.state,
        credential: joined.credential,
        ledgerEntries: joined.ledgerTokens,
        options: {
          keyRetention: { maximumForwardRatchetSteps },
          resolveLedgerEntries: setup.group.resolveLedgerEntries,
        },
      })
      await receiver.decrypt(await author.encrypt(payload))
      const privateHandle = denyApplicationSend(
        await restore(author, encodeClientState(author.state)),
      )
      const reserved = await reserveApplicationRange(privateHandle, { ...range, floor: 490 })
      if (reserved == null) throw new Error('Missing reservation')
      const sender = await restore(author, reserved.pre)
      const frame = await sender.encryptApplication(payload)
      expect(frame.generation).toBe(490)
      expect((await receiver.decrypt(frame.ciphertext)).payload).toEqual(payload)
      expect(receiver.context.clientConfig?.keyRetentionConfig.maximumForwardRatchetSteps).toBe(500)
      expect(
        createMlsContext(receiver.context.cipherSuite, undefined, {
          keyRetention: { maximumForwardRatchetSteps: 600 },
        }).clientConfig?.keyRetentionConfig.maximumForwardRatchetSteps,
      ).toBe(600)
    } finally {
      vi.restoreAllMocks()
    }
  },
)

test('testing reservation refuses another handle token and an expired token', async () => {
  const handle = await fresh()
  const other = await fresh()
  const before = encodeClientState(handle.state)
  const saved = await serializeHandle(other, async (holding) => {
    await expect(handle[reserveApplicationKernel](16, holding)).rejects.toThrow(TypeError)
    return holding
  })
  await expect(other[reserveApplicationKernel](16, saved)).rejects.toThrow(TypeError)
  expect(encodeClientState(handle.state)).toEqual(before)
  expect(ownApplicationGeneration(other.state)).toBe(0)
})
