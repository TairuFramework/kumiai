import { asLogPosition, GroupSafetyHeldError, type SendAdmission } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import type { HandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { deferred } from '../src/runtime.js'
import { createRealGroup, testHandleAccess } from './fixtures/real-group.js'

const frame = {
  id: 'safety-frame',
  protocol: 'safety',
  segment: 0,
  topicID: 'safety-topic',
  position: asLogPosition('1'),
  epoch: 0,
}
const bytes = new Uint8Array([1, 2, 3])
const boundaries = [
  'wrap',
  'ephemeral unwrap',
  'durable unwrap',
  'sealEntries',
  'openEntries',
  'exportSecret',
] as const

async function fixture() {
  const group = await createRealGroup(1, 'crypto-safety')
  const member = group.committer
  let adapterError: Error | null = null
  const base = testHandleAccess({
    handle: () => {
      if (adapterError !== null) throw adapterError
      return member.handle
    },
    adopt: (next) => {
      member.handle = next
    },
  })
  let admission: SendAdmission = { epoch: Number(member.handle.epoch), admissible: true }
  const access: HandleAccess = { ...base, admission: () => admission }
  const encrypt = vi.spyOn(member.handle, 'encrypt')
  const decrypt = vi.spyOn(member.handle, 'decrypt')
  const staged = vi.spyOn(member.handle, 'decryptStaged')
  const exporter = vi.spyOn(member.handle, 'exportSecret')
  const pending = {
    persistOpened: vi.fn(async () => {}),
    list: async () => [],
    complete: async () => {},
  }
  const crypto = createGroupCrypto({ access, pending })
  const sealed = (await crypto.sealEntries(bytes)).sealed
  exporter.mockClear()
  function run(boundary: (typeof boundaries)[number]) {
    switch (boundary) {
      case 'wrap':
        return crypto.wrap(bytes)
      case 'ephemeral unwrap':
        return crypto.unwrap(bytes)
      case 'durable unwrap':
        return crypto.unwrap(bytes, { frame })
      case 'sealEntries':
        return crypto.sealEntries(bytes)
      case 'openEntries':
        return crypto.openEntries(sealed)
      case 'exportSecret':
        return crypto.exportSecret('safety-export')
    }
  }
  return {
    base,
    access,
    crypto,
    run,
    failAccess(error: Error) {
      adapterError = error
    },
    hold(reason: 'fork-halted' | 'recovery-unavailable' | 'lapsed') {
      admission = { epoch: Number(member.handle.epoch), admissible: false, reason }
    },
    assertUnused() {
      expect(encrypt).not.toHaveBeenCalled()
      expect(decrypt).not.toHaveBeenCalled()
      expect(staged).not.toHaveBeenCalled()
      expect(exporter).not.toHaveBeenCalled()
      expect(pending.persistOpened).not.toHaveBeenCalled()
    },
  }
}

for (const reason of ['fork-halted', 'recovery-unavailable'] as const) {
  describe(`crypto safety (${reason})`, () => {
    test.each(boundaries)('%s refuses before crypto', async (boundary) => {
      const f = await fixture()
      f.hold(reason)
      await expect(Promise.resolve().then(() => f.run(boundary))).rejects.toMatchObject({
        name: 'GroupSafetyHeldError',
        reason,
      })
      f.assertUnused()
    })
    test.each(boundaries)('queued %s rechecks before crypto', async (boundary) => {
      const f = await fixture()
      const started = deferred<void>()
      const release = deferred<void>()
      const blocking = f.base.read(async () => {
        started.resolve()
        await release.promise
      })
      await started.promise
      const running = Promise.resolve().then(() => f.run(boundary))
      const assertion = expect(running).rejects.toMatchObject({
        name: 'GroupSafetyHeldError',
        reason,
      })
      await Promise.resolve()
      f.hold(reason)
      release.resolve()
      await blocking
      await assertion
      f.assertUnused()
    })
    test('durable unwrap preserves held refusal raised by access', async () => {
      const f = await fixture()
      // The callback gate is covered above. This adapter failure must retain the public error class.
      const held = new GroupSafetyHeldError(reason)
      f.failAccess(held)
      await expect(f.crypto.unwrap(bytes, { frame })).rejects.toBe(held)
      f.assertUnused()
    })
  })
}

test('ordinary lapsed control entry reads remain available', async () => {
  const f = await fixture()
  f.hold('lapsed')
  const sealed = await f.crypto.sealEntries(bytes)
  expect(await f.crypto.openEntries(sealed.sealed)).toEqual(bytes)
})
