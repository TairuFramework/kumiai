import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import type { Runtime } from '@sozai/runtime'
import { afterEach, expect, test, vi } from 'vitest'

import type { HandleAccess } from '../src/access.js'
import { simpleHandleAccess } from '../src/access.js'
import {
  createGroupCrypto,
  createRecoveryPending,
  deriveEntryKey,
  deriveRecoverySecret,
  ENTRY_SEAL_LABEL,
  openEntries,
  RECOVERY_LABEL,
  sealEntries,
} from '../src/index.js'
import { createRealGroup } from './fixtures/real-group.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('standalone entry helpers preserve the factory blob format in both directions', async () => {
  const key = Uint8Array.from({ length: 32 }, (_, index) => index)
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => index + 32)
  const entries = new TextEncoder().encode('entry bodies')
  const runtime = {
    getRandomValues: (bytes: Uint8Array) => {
      bytes.set(nonce)
      return bytes
    },
  } as Runtime
  const oldSealed = new Uint8Array(1 + nonce.length + entries.length + 16)
  oldSealed[0] = 1
  oldSealed.set(nonce, 1)
  oldSealed.set(xchacha20poly1305(key, nonce).encrypt(entries), 25)

  expect(sealEntries(key, entries, runtime)).toEqual(oldSealed)
  expect(openEntries(key, oldSealed)).toEqual(entries)
  expect(openEntries(key, sealEntries(key, entries, runtime))).toEqual(entries)
  expect(key).toEqual(Uint8Array.from({ length: 32 }, (_, index) => index))
  expect(oldSealed.length).toBe(1 + 24 + entries.length + 16)

  const handle = {
    epoch: 0n,
    exportSecret: async () => Uint8Array.from(key),
  } as unknown as import('@kumiai/mls').GroupHandle
  const crypto = createGroupCrypto({
    access: simpleHandleAccess({ handle: () => handle, adopt: () => {} }),
    runtime,
  })
  expect(await crypto.sealEntries(entries)).toEqual(oldSealed)
  expect(await crypto.openEntries(sealEntries(key, entries, runtime))).toEqual(entries)
})

test('standalone open keeps the existing errors', () => {
  const key = new Uint8Array(32)
  expect(() => openEntries(key, new Uint8Array(25))).toThrow('openEntries: not a sealed blob')
  const future = new Uint8Array(26)
  future[0] = 2
  expect(() => openEntries(key, future)).toThrow('openEntries: unsupported blob version 2')
  const sealed = sealEntries(key, new Uint8Array([1]))
  sealed[sealed.length - 1] = (sealed[sealed.length - 1] as number) ^ 1
  expect(() => openEntries(key, sealed)).toThrow()
})

test('factory seals after releasing access and wipes the derived key on a seal error', async () => {
  const keys: Array<Uint8Array> = []
  let inRead = false
  let failRandom = false
  const handle = {
    epoch: 0n,
    exportSecret: async () => {
      const key = new Uint8Array(32).fill(7)
      keys.push(key)
      return key
    },
  } as unknown as import('@kumiai/mls').GroupHandle
  const base = simpleHandleAccess({ handle: () => handle, adopt: () => {} })
  const access: HandleAccess = {
    ...base,
    read: async (fn) => {
      inRead = true
      try {
        return await base.read(fn)
      } finally {
        inRead = false
      }
    },
  }
  const runtime = {
    getRandomValues: (bytes: Uint8Array) => {
      expect(inRead).toBe(false)
      if (failRandom) throw new Error('random failed')
      bytes.fill(3)
      return bytes
    },
  } as Runtime
  const crypto = createGroupCrypto({ access, runtime })
  const sealed = await crypto.sealEntries(new Uint8Array([1]))
  expect(await crypto.openEntries(sealed)).toEqual(new Uint8Array([1]))
  expect(keys.every((key) => key.every((byte) => byte === 0))).toBe(true)
  failRandom = true
  await expect(crypto.sealEntries(new Uint8Array([2]))).rejects.toThrow('random failed')
  expect(keys.at(-1)?.every((byte) => byte === 0)).toBe(true)
})

test('entry and recovery derivation use the existing labels, context and bytes', async () => {
  const group = await createRealGroup(1, 'standalone-derivation')
  const handle = group.committer.handle
  const expected = await handle.exportSecret(ENTRY_SEAL_LABEL, new Uint8Array(), 32)
  expect(await deriveEntryKey(handle)).toEqual(expected)
  const label = 'custom-entry-label'
  expect(await deriveEntryKey(handle, label)).toEqual(
    await handle.exportSecret(label, new Uint8Array(), 32),
  )
  const recovery = await deriveRecoverySecret(handle)
  const { cipherSuite } = handle.context
  const { encodeGroupAnchor } = await import('@kumiai/mls')
  const utf8 = new TextEncoder()
  expect(recovery).toEqual(
    await cipherSuite.kdf.expand(
      await cipherSuite.kdf.extract(utf8.encode(handle.groupID), encodeGroupAnchor(handle.anchor)),
      utf8.encode(RECOVERY_LABEL),
      32,
    ),
  )
})

test('pending recovery keys expire at 120,000 ms and sweep on access', () => {
  vi.useFakeTimers()
  const pending = createRecoveryPending()
  const key = new Uint8Array([1, 2, 3])
  pending.put('a', key)
  vi.advanceTimersByTime(119_999)
  expect(pending.get('a')).toBe(key)
  vi.advanceTimersByTime(1)
  expect(pending.get('a')).toBeNull()
  expect(key).toEqual(new Uint8Array(3))

  const custom = createRecoveryPending({ ttlMS: 10 })
  const stale = new Uint8Array([9])
  custom.put('stale', stale)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11)
  expect(custom.get('stale')).toBeNull()
  expect(stale[0]).toBe(0)
})

test('pending replacement and deletion zero keys and cancel old timers', () => {
  vi.useFakeTimers()
  const pending = createRecoveryPending({ ttlMS: 20 })
  const first = new Uint8Array([1])
  const second = new Uint8Array([2])
  pending.put('same', first)
  vi.advanceTimersByTime(5)
  pending.put('same', second)
  expect(first[0]).toBe(0)
  vi.advanceTimersByTime(15)
  expect(pending.get('same')).toBe(second)
  pending.delete('same')
  expect(second[0]).toBe(0)
  expect(pending.get('same')).toBeNull()
})

test('pending timer is unrefed', () => {
  const timeout = vi.spyOn(globalThis, 'setTimeout')
  const pending = createRecoveryPending()
  pending.put('a', new Uint8Array([1]))
  const timer = timeout.mock.results.at(-1)?.value as NodeJS.Timeout
  expect(timer.hasRef()).toBe(false)
  pending.delete('a')
})
