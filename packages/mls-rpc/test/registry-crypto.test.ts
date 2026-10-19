import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  processWelcome,
} from '@kumiai/mls'
import {
  AppFrameStorageError,
  encodeAppAAD,
  FrameEpochError,
  frameID,
  GroupSafetyHeldError,
  InvalidAppEntryError,
  type PendingAppFrame,
} from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { isFrameAhead } from '../../rpc/lib/crypto.js'
import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto, ENTRY_SEAL_LABEL } from '../src/crypto.js'
import { entryCapability } from '../src/entry-capability.js'
import { DisplacedGroupHandleError, RegistryRetiringError } from '../src/persistence-errors.js'
import { MAX_OPEN_BATCH_FRAMES, type OpenAppInput } from '../src/persistence-types.js'
import { gateRegistryMaintenance } from '../src/testing.js'
import {
  createRegistryFixture,
  failRegistrySeal,
  registryFixtureRetirement,
} from './fixtures/registry.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'
import { registryHandle } from './fixtures/registry-welcome.js'

async function promptly<T>(pending: T | PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Lease refusal did not settle promptly')), 500)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function setup(mode: 'real-mls' | 'double') {
  const groupID = `registry-crypto-${mode}`
  const f = await createRegistryFixture({ mode, setup: 'empty', groupID })
  const remote = randomIdentity()
  const options = f.environment.options ?? {}
  const base = (await createGroup(f.identity, groupID, options)).group
  const bundle = await createKeyPackageBundle(remote, options)
  const { invite } = await createInvite({
    group: base,
    identity: f.identity,
    recipientDID: remote.id,
    permission: 'member',
  })
  const added = await commitInvite(base, bundle.publicPackage, invite)
  const joined = (
    await processWelcome({
      identity: remote,
      invite,
      welcome: added.welcomeMessage,
      keyPackageBundle: bundle,
      options,
    })
  ).group
  const sender = await registryHandle({ mode, handle: joined, options })
  const key = await f.registry.seed(
    await registryHandle({ mode, handle: added.newGroup, options }),
    { packageUse: { sourceID: 'registry-crypto', ref: 'joined', kind: 'ordinary' } },
  )
  const access = await f.registry.access(key.groupID)
  const crypto = createGroupCrypto({ access })
  return {
    f,
    key,
    access,
    crypto,
    sender,
    senderDID: remote.id,
    async seal(position = '000000000001', payload = encodeEventFrame('posted', { text: 'hello' })) {
      const topicID = 'app-X'
      const expectedAAD = encodeAppAAD({ topicID, intent: 'log' })
      const ciphertext = await sender.encrypt(payload, { aad: expectedAAD })
      return {
        ciphertext,
        expectedAAD,
        frame: {
          id: frameID(topicID, ciphertext),
          topicID,
          protocol: 'chat',
          segment: access.epoch(),
          position,
        },
      }
    },
    async advance() {
      const { candidate, expected, write } = await f.acceptedOrdinary(access)
      expect(await access.adopt(candidate, expected, write)).toBe('installed')
    },
    async snapshot() {
      return {
        lifetime: await f.device.groups.load(key.groupID),
        state: await f.device.groups.loadState(key),
        rows: await f.inspectRows(),
      }
    },
    async halt() {
      const trust = await f.device.groups.loadTrust(key.groupID)
      if (trust === null) throw new Error('Missing trust')
      const remote = trust.installed.authenticator.slice()
      remote[0] = (remote[0] ?? 0) ^ 1
      await f.safety().reportFork(key, {
        kind: 'epoch-authenticator',
        epoch: trust.installed.epoch,
        local: trust.installed.authenticator,
        remote,
      })
    },
  }
}

type Setup = Awaited<ReturnType<typeof setup>>
type Input = Awaited<ReturnType<Setup['seal']>>

function unwrap(s: Setup, input: Input) {
  return s.crypto.unwrap(input.ciphertext, { frame: input.frame, expectedAAD: input.expectedAAD })
}

function batchInput(s: Setup, input: Input): OpenAppInput {
  return { ...input, frame: { ...s.key, ...input.frame } }
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry crypto / ${mode}`, () => {
    const run = async (fn: (s: Setup) => Promise<void>) => {
      const s = await setup(mode)
      try {
        await fn(s)
      } finally {
        await s.f.close()
      }
    }

    test('durable unwrap opens through one transition and lists the record', () =>
      run(async (s) => {
        const input = await s.seal()
        const before = await s.snapshot()
        const result = await unwrap(s, input)
        expect(result).toEqual({
          payload: encodeEventFrame('posted', { text: 'hello' }),
          senderDID: s.senderDID,
          epoch: s.access.epoch(),
        })
        const after = await s.snapshot()
        expect(after.lifetime?.revision).toBe((before.lifetime?.revision ?? 0) + 1)
        expect(after.state?.version).toBe((before.state?.version ?? 0) + 1)
        expect(await s.crypto.pending.list()).toMatchObject([
          { frame: { ...s.key, ...input.frame, procedure: 'posted' }, ...result },
        ])
        await s.crypto.pending.complete(input.frame.id)
        expect(await s.crypto.pending.list()).toEqual([])
      }))

    test('durable unwrap dispatches to openBatch without legacy mutation', () =>
      run(async (s) => {
        const input = await s.seal()
        const openBatch = vi.spyOn(s.access, 'openBatch')
        const mutate = vi.spyOn(s.access, 'mutate')
        expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
        expect(openBatch).toHaveBeenCalledExactlyOnceWith([batchInput(s, input)])
        expect(mutate).not.toHaveBeenCalled()
      }))

    test('non-retained past epoch maps to FrameEpochError', () =>
      run(async (s) => {
        const input = await s.seal()
        for (let i = 0; i < 5; i++) await s.advance()
        const error = await Promise.resolve(unwrap(s, input)).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(FrameEpochError)
        expect(error).toMatchObject({
          frameEpoch: input.frame.segment,
          handleEpoch: s.access.epoch(),
        })
        expect(isFrameAhead(error)).toBe(false)
      }))

    test('future epoch maps to an ahead FrameEpochError', () =>
      run(async (s) => {
        const input = await s.seal()
        const future = await s.f.advance(await s.access.read((handle) => handle))
        input.ciphertext = await future.encrypt(encodeEventFrame('posted'), {
          aad: input.expectedAAD,
        })
        input.frame.id = frameID(input.frame.topicID, input.ciphertext)
        const error = await Promise.resolve(unwrap(s, input)).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(FrameEpochError)
        expect(isFrameAhead(error)).toBe(true)
        expect(error).toMatchObject({
          frameEpoch: s.access.epoch() + 1,
          handleEpoch: s.access.epoch(),
        })
      }))

    test('malformed plaintext maps to InvalidAppEntryError', () =>
      run(async (s) => {
        const input = await s.seal(undefined, new TextEncoder().encode('{}'))
        await expect(unwrap(s, input)).rejects.toBeInstanceOf(InvalidAppEntryError)
        expect(await s.crypto.pending.list()).toEqual([])
      }))

    test.each([
      'wrong-aad',
      'invalid-ciphertext',
      'duplicate',
      'invalid-position',
      'mismatched-id',
    ])('%s maps to a plain crypto Error without writing', (reason) =>
      run(async (s) => {
        const input = await s.seal()
        if (reason === 'wrong-aad') input.expectedAAD = new Uint8Array([1])
        if (reason === 'invalid-ciphertext') {
          input.ciphertext = new Uint8Array([1, 2, 3])
          input.frame.id = frameID(input.frame.topicID, input.ciphertext)
        }
        if (reason === 'duplicate') {
          await unwrap(s, input)
          input.frame.position = '000000000002'
        }
        if (reason === 'invalid-position') input.frame.position = ''
        if (reason === 'mismatched-id')
          input.frame.id = frameID(input.frame.topicID, new Uint8Array([9]))
        const before = await s.snapshot()
        const openBatch = vi.spyOn(s.access, 'openBatch')
        const error = await Promise.resolve(unwrap(s, input)).catch((error: unknown) => error)
        expect(openBatch).toHaveBeenCalledExactlyOnceWith([batchInput(s, input)])
        expect(error).toBeInstanceOf(Error)
        expect(error?.constructor).toBe(Error)
        expect(error).not.toBeInstanceOf(FrameEpochError)
        expect(error).not.toBeInstanceOf(AppFrameStorageError)
        expect(await s.snapshot()).toEqual(before)
        if (reason === 'mismatched-id') {
          input.frame.id = frameID(input.frame.topicID, input.ciphertext)
          expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
        }
      }),
    )

    test('retained past epoch unwraps', () =>
      run(async (s) => {
        const input = await s.seal()
        const epoch = s.access.epoch()
        await s.advance()
        expect(await unwrap(s, input)).toMatchObject({
          senderDID: s.senderDID,
          epoch: epoch + 1,
        })
        expect(await s.crypto.pending.list()).toMatchObject([{ epoch }])
        await s.advance()
        const before = await s.snapshot()
        expect(await unwrap(s, input)).toMatchObject({
          senderDID: s.senderDID,
          epoch: epoch + 2,
        })
        expect(await s.crypto.pending.list()).toMatchObject([{ epoch }])
        expect(await s.snapshot()).toEqual(before)
      }))

    test('transient codec RangeError is retryable storage failure', () =>
      run(async (s) => {
        const input = await s.seal()
        const before = await s.snapshot()
        const cause = new RangeError('transient codec capacity')
        failRegistrySeal(s.f, cause)
        const error = await Promise.resolve(unwrap(s, input)).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(AppFrameStorageError)
        expect(error).toHaveProperty('cause', cause)
        expect(await s.snapshot()).toEqual(before)
        expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
        expect(await s.crypto.pending.list()).toHaveLength(1)
      }))

    test('unreadable retained trust becomes a recovery safety hold', () =>
      run(async (s) => {
        const input = await s.seal()
        await s.f.corruptTrust(s.key.groupID)
        await expect(unwrap(s, input)).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
          reason: 'recovery-unavailable',
        })
      }))

    test('storage failure is AppFrameStorageError and writes nothing', () =>
      run(async (s) => {
        const input = await s.seal()
        const before = await s.snapshot()
        s.f.armNextWorkFault('after-first-write')
        const error = await Promise.resolve(unwrap(s, input)).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(AppFrameStorageError)
        expect(error).toHaveProperty('cause', expect.any(Error))
        expect(await s.snapshot()).toEqual(before)
        expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
        expect(await s.crypto.pending.list()).toHaveLength(1)
      }))

    test.each(['singleton', 'batch'] as const)(
      '%s retirement refusal stays retryable after rollback',
      (kind) =>
        run(async (s) => {
          const input = await s.seal()
          const before = await s.snapshot()
          const attempt = registryFixtureRetirement(s.f.registry).beginRetirement(s.key)
          const open = () =>
            kind === 'singleton' ? unwrap(s, input) : s.crypto.unwrapBatch([batchInput(s, input)])
          try {
            const error = await Promise.resolve(open()).catch((error: unknown) => error)
            expect(error).toBeInstanceOf(AppFrameStorageError)
            expect(error).toHaveProperty('cause', expect.any(RegistryRetiringError))
            expect(await s.snapshot()).toEqual(before)
          } finally {
            attempt.settle('rolled-back')
          }
          const opened = await open()
          expect(opened).toMatchObject(
            kind === 'singleton'
              ? { senderDID: s.senderDID }
              : [{ kind: 'opened', record: { senderDID: s.senderDID } }],
          )
          expect(await s.crypto.pending.list()).toHaveLength(1)
        }),
    )

    test.each([new Error('admission unavailable'), new RangeError('admission unavailable')])(
      'admission failure %s stays a storage error',
      (cause) =>
        run(async (s) => {
          const input = await s.seal()
          const before = await s.snapshot()
          vi.spyOn(s.access, 'admission').mockImplementation(() => {
            throw cause
          })
          for (const open of [
            () => unwrap(s, input),
            () => s.crypto.unwrapBatch([batchInput(s, input)]),
          ]) {
            const error = await Promise.resolve(open()).catch((error: unknown) => error)
            expect(error).toBeInstanceOf(AppFrameStorageError)
            expect(error).toHaveProperty('cause', cause)
          }
          expect(await s.snapshot()).toEqual(before)
        }),
    )

    test.each([0, 2])('singleton refuses %i batch results as a storage invariant', (length) =>
      run(async (s) => {
        const input = await s.seal()
        const before = await s.snapshot()
        vi.spyOn(s.access, 'openBatch').mockResolvedValueOnce(
          Array.from({ length }, () => ({
            kind: 'refused',
            reason: 'invalid-ciphertext',
            frame: batchInput(s, input).frame,
            keyConsumed: false,
          })),
        )
        await expect(unwrap(s, input)).rejects.toBeInstanceOf(AppFrameStorageError)
        expect(await s.snapshot()).toEqual(before)
        expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
      }),
    )

    test('legacy durable codec RangeError keeps the key retryable', () =>
      run(async (s) => {
        const input = await s.seal()
        let handle = await s.access.read((group) => group)
        const access = simpleHandleAccess({
          key: s.key,
          stateVersion: () => s.access.stateVersion(),
          handle: () => handle,
          adopt: (next) => {
            handle = next
          },
        })
        const records: Array<PendingAppFrame> = []
        const cause = new RangeError('transient legacy codec capacity')
        let fail = true
        const crypto = createGroupCrypto({
          access,
          pending: {
            persistOpened: async (_state, record) => {
              if (fail) {
                fail = false
                throw cause
              }
              records.push(record)
            },
            list: async () => records,
            complete: async () => {},
          },
        })
        const before = encodeClientState(handle.state)
        const open = () =>
          crypto.unwrap(input.ciphertext, { frame: input.frame, expectedAAD: input.expectedAAD })
        const error = await Promise.resolve(open()).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(AppFrameStorageError)
        expect(error).toHaveProperty('cause', cause)
        expect(records).toEqual([])
        expect(encodeClientState(handle.state)).toEqual(before)
        expect(await open()).toMatchObject({ senderDID: s.senderDID })
        expect(records).toHaveLength(1)
      }))

    test.each(['preflight', 'callback'] as const)(
      'legacy durable %s retirement refusal stays retryable after rollback',
      (boundary) =>
        run(async (s) => {
          const input = await s.seal()
          let handle = await s.access.read((group) => group)
          const access = {
            ...simpleHandleAccess({
              key: s.key,
              stateVersion: () => s.access.stateVersion(),
              handle: () => handle,
              adopt: (next) => {
                handle = next
              },
            }),
            admission: () => s.access.admission(),
          }
          const records: Array<PendingAppFrame> = []
          const crypto = createGroupCrypto({
            access,
            pending: {
              persistOpened: async (_state, record) => {
                records.push(record)
              },
              list: async () => records,
              complete: async () => {},
            },
          })
          const before = await s.snapshot()
          const retirement = registryFixtureRetirement(s.f.registry)
          let attempt: ReturnType<typeof retirement.beginRetirement> | undefined
          if (boundary === 'preflight') attempt = retirement.beginRetirement(s.key)
          else {
            const open = access.open
            vi.spyOn(access, 'open').mockImplementationOnce((fn, persist) => {
              attempt = retirement.beginRetirement(s.key)
              return open(fn, persist)
            })
          }
          const open = () =>
            crypto.unwrap(input.ciphertext, {
              frame: input.frame,
              expectedAAD: input.expectedAAD,
            })
          try {
            const error = await Promise.resolve(open()).catch((error: unknown) => error)
            expect(error).toBeInstanceOf(AppFrameStorageError)
            expect(error).toHaveProperty('cause', expect.any(RegistryRetiringError))
            expect(records).toEqual([])
            expect(await s.snapshot()).toEqual(before)
          } finally {
            attempt?.settle('rolled-back')
          }
          expect(await open()).toMatchObject({ senderDID: s.senderDID })
          expect(records).toHaveLength(1)
        }),
    )

    test.each(['groupID', 'incarnation'] as const)(
      'a frame bound to another %s never completes as dead',
      (field) =>
        run(async (s) => {
          const input = await s.seal()
          const frame = {
            ...s.key,
            ...input.frame,
            [field]: field === 'groupID' ? 'another-group' : s.key.incarnation + 1,
          }
          const before = await s.snapshot()
          const error = await Promise.resolve(
            s.crypto.unwrap(input.ciphertext, { frame, expectedAAD: input.expectedAAD }),
          ).catch((error: unknown) => error)
          expect(error).toBeInstanceOf(AppFrameStorageError)
          expect(error).toHaveProperty('cause', expect.any(DisplacedGroupHandleError))
          expect(await s.snapshot()).toEqual(before)
          expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
        }),
    )

    test('matching supplied GroupKey unwraps', () =>
      run(async (s) => {
        const input = await s.seal()
        expect(
          await s.crypto.unwrap(input.ciphertext, {
            frame: { ...s.key, ...input.frame },
            expectedAAD: input.expectedAAD,
          }),
        ).toMatchObject({ senderDID: s.senderDID })
      }))

    test('replayed unwrap returns the saved record', () =>
      run(async (s) => {
        const input = await s.seal()
        const first = await unwrap(s, input)
        const before = await s.snapshot()
        expect(await unwrap(s, input)).toEqual(first)
        expect(await s.crypto.pending.list()).toHaveLength(1)
        expect(await s.snapshot()).toEqual(before)
      }))

    test('unwrapBatch never rejects valid siblings', () =>
      run(async (s) => {
        const valid = await s.seal('000000000002')
        const junk = {
          ...batchInput(s, valid),
          ciphertext: new Uint8Array([1, 2, 3]),
          frame: {
            ...s.key,
            ...valid.frame,
            id: frameID(valid.frame.topicID, new Uint8Array([1, 2, 3])),
            position: '000000000001',
          },
        }
        expect(await s.crypto.unwrapBatch([junk, batchInput(s, valid)])).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          { kind: 'opened', record: { senderDID: s.senderDID } },
        ])
        expect(await s.crypto.pending.list()).toHaveLength(1)
      }))

    test('fork-halted rejects before any read', () =>
      run(async (s) => {
        const input = await s.seal()
        await s.halt()
        const read = vi.spyOn(s.access, 'read')
        const mutate = vi.spyOn(s.access, 'mutate')
        const openBatch = vi.spyOn(s.access, 'openBatch')
        await expect(unwrap(s, input)).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
          reason: 'fork-halted',
        })
        await expect(s.crypto.unwrapBatch([batchInput(s, input)])).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
          reason: 'fork-halted',
        })
        expect(read).not.toHaveBeenCalled()
        expect(mutate).not.toHaveBeenCalled()
        expect(openBatch).not.toHaveBeenCalled()
      }))

    test('openBatch safety and oversized batch rejections pass through unchanged', () =>
      run(async (s) => {
        const input = await s.seal()
        for (const error of [new GroupSafetyHeldError('fork-halted')]) {
          vi.spyOn(s.access, 'openBatch').mockRejectedValueOnce(error)
          await expect(unwrap(s, input)).rejects.toBe(error)
        }
        await expect(
          s.crypto.unwrapBatch(
            Array.from({ length: MAX_OPEN_BATCH_FRAMES + 1 }, () => batchInput(s, input)),
          ),
        ).rejects.toBeInstanceOf(RangeError)
      }))

    test('wrap and frame-less unwrap use only seal and receive without transactions', () =>
      run(async (s) => {
        const capability = entryCapability(s.f.device.groups)
        if (capability === null) throw new Error('Missing entry capability')
        const transactions = vi.spyOn(capability, 'run')
        const seal = vi.spyOn(s.access, 'seal')
        const receive = vi.spyOn(s.access, 'receive')
        const mutate = vi.spyOn(s.access, 'mutate')
        const openBatch = vi.spyOn(s.access, 'openBatch')
        const payload = new Uint8Array([3, 4, 5])
        const aad = encodeAppAAD({ topicID: 'reply', intent: 'ephemeral' })
        const wrapped = await s.crypto.wrap(payload, { aad })
        expect((await s.sender.decrypt(wrapped)).payload).toEqual(payload)
        const ciphertext = await s.sender.encrypt(payload, { aad })
        expect(await s.crypto.unwrap(ciphertext, { expectedAAD: aad })).toEqual({
          payload,
          senderDID: s.senderDID,
          epoch: s.access.epoch(),
        })
        expect(seal).toHaveBeenCalledExactlyOnceWith(payload, { aad, intent: 'ephemeral' })
        expect(receive).toHaveBeenCalledExactlyOnceWith([{ ciphertext, expectedAAD: aad }])
        expect(mutate).not.toHaveBeenCalled()
        expect(openBatch).not.toHaveBeenCalled()
        expect(transactions).not.toHaveBeenCalled()
        expect(await s.crypto.pending.list()).toEqual([])
      }))

    test('log-intent frame refuses frame-less unwrap and still opens durably', () =>
      run(async (s) => {
        const input = await s.seal()
        await expect(s.crypto.unwrap(input.ciphertext)).rejects.toThrow(
          'unwrap: app frame refused (log-intent)',
        )
        expect(await unwrap(s, input)).toMatchObject({ senderDID: s.senderDID })
      }))

    test.each([
      ['empty', new Uint8Array()],
      ['unrecognised non-empty', new Uint8Array([9, 8, 7])],
    ] as const)('wrap treats %s AAD as ephemeral and preserves its bytes', (_label, aad) =>
      run(async (s) => {
        const payload = new Uint8Array([7])
        const ciphertext = await s.crypto.wrap(payload, { aad })
        expect(s.crypto.frameAAD(ciphertext)).toEqual(aad)
        expect((await s.sender.decrypt(ciphertext)).payload).toEqual(payload)
        await expect(s.access.seal(payload, { aad, intent: 'log' })).rejects.toBeInstanceOf(
          TypeError,
        )
      }),
    )

    test.each(['log', 'ephemeral'] as const)(
      'seal refuses recognised %s AAD with the opposite intent before consuming a generation',
      (intent) =>
        run(async (s) => {
          const aad = encodeAppAAD({ topicID: 'app-X', intent })
          const payload = new Uint8Array([7])
          await expect(
            s.access.seal(payload, { aad, intent: intent === 'log' ? 'ephemeral' : 'log' }),
          ).rejects.toBeInstanceOf(TypeError)
          const sealed = await s.access.seal(payload, { aad, intent })
          expect(sealed.generation).toBe(0)
          expect((await s.sender.decrypt(sealed.ciphertext)).payload).toEqual(payload)
        }),
    )

    test.each(
      (['log', 'ephemeral'] as const).flatMap((intent) =>
        (['aad-bytes', 'options', 'plaintext'] as const).map((mutation) => ({ intent, mutation })),
      ),
    )('seal snapshots $intent inputs before caller mutates $mutation', ({ intent, mutation }) =>
      run(async (s) => {
        const aad = encodeAppAAD({ topicID: 'reply', intent })
        const originalAAD = aad.slice()
        const plaintext = new Uint8Array([7, 8])
        const opts = { aad, intent }
        const pending = s.access.seal(plaintext, opts)
        const opposite = intent === 'log' ? 'ephemeral' : 'log'
        if (mutation === 'aad-bytes') aad.set(encodeAppAAD({ topicID: 'reply', intent: opposite }))
        if (mutation === 'options') {
          opts.aad = encodeAppAAD({ topicID: 'changed', intent: opposite })
          opts.intent = opposite
        }
        if (mutation === 'plaintext') plaintext.fill(9)
        const sealed = await pending
        expect(s.crypto.frameAAD(sealed.ciphertext)).toEqual(originalAAD)
        expect((await s.sender.decrypt(sealed.ciphertext)).payload).toEqual(new Uint8Array([7, 8]))
      }),
    )

    test.each(['log', 'ephemeral'] as const)(
      'seal snapshots %s intent for cold lease waits',
      async (intent) => {
        const fixture = await createRegistryLeaseFixture(mode)
        const gate = gateRegistryMaintenance(fixture.fixture().registry)
        try {
          await fixture.dropOwner()
          const opts = { aad: fixture.aad(intent), intent }
          const pending = fixture.access().seal(new Uint8Array([7]), opts)
          const outcome = pending.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          )
          opts.intent = intent === 'log' ? 'ephemeral' : 'log'
          opts.aad = fixture.aad(opts.intent)
          await gate.started
          if (intent === 'ephemeral') {
            await expect(promptly(outcome)).resolves.toMatchObject({
              error: { name: 'ApplicationLeaseUnavailableError', reason: 'cold' },
            })
          }
          gate.release()
          if (intent === 'log')
            await expect(outcome).resolves.toMatchObject({ value: { generation: 16 } })
          else await outcome
        } finally {
          gate.release()
          await fixture.close()
        }
      },
    )

    test.each(['cold', 'deferred', 'exhausted', 'rotation-required', 'terminal'] as const)(
      'wrap refuses %s sending through the registry adapter',
      async (reason) => {
        const fixture = await createRegistryLeaseFixture(
          mode,
          'seed',
          reason === 'rotation-required' ? 499 : 0,
        )
        const gate = gateRegistryMaintenance(fixture.fixture().registry)
        try {
          if (reason === 'cold') await fixture.dropOwner()
          if (reason === 'deferred') {
            const proposal = await fixture.proposal()
            await fixture.access().mutate(async (handle) => {
              handle.state.unappliedProposals = proposal
            })
          }
          if (reason === 'terminal') await fixture.setUnavailable()
          const crypto = createGroupCrypto({ access: fixture.access() })
          const aad = fixture.aad('ephemeral')
          if (reason === 'rotation-required') await crypto.wrap(new Uint8Array([1]), { aad })
          if (reason === 'exhausted')
            for (let generation = 0; generation < 16; generation++)
              await crypto.wrap(new Uint8Array([1]), { aad })
          await expect(promptly(crypto.wrap(new Uint8Array([2]), { aad }))).rejects.toMatchObject({
            name:
              reason === 'terminal' || reason === 'rotation-required'
                ? 'SendNotAdmissibleError'
                : 'ApplicationLeaseUnavailableError',
            reason,
          })
        } finally {
          gate.release()
          await fixture.close()
        }
      },
    )

    test('wrap with log intent waits for cold maintenance', async () => {
      const fixture = await createRegistryLeaseFixture(mode)
      const gate = gateRegistryMaintenance(fixture.fixture().registry)
      try {
        await fixture.dropOwner()
        const crypto = createGroupCrypto({ access: fixture.access() })
        let settled = false
        const pending = Promise.resolve(
          crypto.wrap(new Uint8Array([7]), { aad: fixture.aad('log') }),
        )
        void pending.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        await gate.started
        expect(settled).toBe(false)
        gate.release()
        await expect(pending).resolves.toBeInstanceOf(Uint8Array)
      } finally {
        gate.release()
        await fixture.close()
      }
    })

    test('frame-less unwrap checks AAD before a future epoch', () =>
      run(async (s) => {
        const future = await s.f.advance(await s.access.read((handle) => handle))
        const aad = encodeAppAAD({ topicID: 'reply', intent: 'ephemeral' })
        const ciphertext = await future.encrypt(new Uint8Array([7]), { aad })
        await expect(
          s.crypto.unwrap(ciphertext, { expectedAAD: new Uint8Array([9]) }),
        ).rejects.toThrow('unwrap: invalid app frame')
        await expect(s.crypto.unwrap(ciphertext, { expectedAAD: aad })).rejects.toBeInstanceOf(
          FrameEpochError,
        )
      }))

    test.each(['consumed', 'closed-epoch', 'capacity', 'generation-bound'] as const)(
      'frame-less unwrap reports the %s refusal',
      (reason) =>
        run(async (s) => {
          vi.spyOn(s.access, 'receive').mockResolvedValueOnce([{ kind: 'refused', reason }])
          await expect(s.crypto.unwrap(new Uint8Array([1]))).rejects.toThrow(
            `unwrap: app frame refused (${reason})`,
          )
        }),
    )

    test('wrap forwards log intent to the durable seal', () =>
      run(async (s) => {
        const seal = vi.spyOn(s.access, 'seal')
        const aad = encodeAppAAD({ topicID: 'app-X', intent: 'log' })
        const payload = new Uint8Array([7])
        await s.crypto.wrap(payload, { aad })
        expect(seal).toHaveBeenCalledExactlyOnceWith(payload, { aad, intent: 'log' })
      }))

    test('frame-less unwrap defaults to the frame AAD and a wrong expectation consumes nothing', () =>
      run(async (s) => {
        const payload = new Uint8Array([7])
        const aad = encodeAppAAD({ topicID: 'reply', intent: 'ephemeral' })
        const ciphertext = await s.sender.encrypt(payload, { aad })
        await expect(
          s.crypto.unwrap(ciphertext, { expectedAAD: new Uint8Array([9]) }),
        ).rejects.toThrow()
        expect(await s.crypto.unwrap(ciphertext)).toMatchObject({ payload, senderDID: s.senderDID })
      }))

    test('frame-less unwrap maps receive results without losing errors or epochs', () =>
      run(async (s) => {
        const receive = vi.spyOn(s.access, 'receive')
        const bytes = new Uint8Array([1])
        receive.mockResolvedValueOnce([{ kind: 'refused', reason: 'invalid' }])
        await expect(s.crypto.unwrap(bytes)).rejects.toThrow('unwrap: invalid app frame')
        const cause = new Error('authenticated open failed')
        receive.mockResolvedValueOnce([{ kind: 'refused', reason: 'invalid', error: cause }])
        await expect(s.crypto.unwrap(bytes)).rejects.toBe(cause)
        for (const reason of ['past-epoch', 'future-epoch'] as const) {
          receive.mockResolvedValueOnce([
            { kind: 'refused', reason, frameEpoch: 2, handleEpoch: 9 },
          ])
          await expect(s.crypto.unwrap(bytes)).rejects.toMatchObject({
            name: 'FrameEpochError',
            frameEpoch: 2,
            handleEpoch: 9,
          })
        }
        receive.mockResolvedValueOnce([
          {
            kind: 'opened',
            payload: bytes,
            aad: new Uint8Array(),
            frameEpoch: 2,
            handleEpoch: 9,
          },
        ])
        await expect(s.crypto.unwrap(bytes)).rejects.toThrow(
          'unwrap: opened frame has no authenticated sender',
        )
        receive.mockResolvedValueOnce([
          {
            kind: 'opened',
            payload: bytes,
            senderDID: s.senderDID,
            aad: new Uint8Array(),
            frameEpoch: 2,
            handleEpoch: 9,
          },
        ])
        expect(await s.crypto.unwrap(bytes)).toEqual({
          payload: bytes,
          senderDID: s.senderDID,
          epoch: 9,
        })
      }))

    test('directed-reply AAD obeys the generation bound', async () => {
      const fixture = await createRegistryLeaseFixture(mode, 'seed', 499)
      try {
        const crypto = createGroupCrypto({ access: fixture.access() })
        const aad = encodeAppAAD({ topicID: 'reply/directed', intent: 'ephemeral' })
        await expect(crypto.wrap(new Uint8Array([1]), { aad })).resolves.toBeInstanceOf(Uint8Array)
        const transactions = fixture.transactions()
        await expect(promptly(crypto.wrap(new Uint8Array([2]), { aad }))).rejects.toMatchObject({
          name: 'SendNotAdmissibleError',
          reason: 'rotation-required',
        })
        expect(fixture.transactions()).toBe(transactions)
      } finally {
        await fixture.close()
      }
    })

    test('shared exporter, entry seals and frame readers work over registry access', () =>
      run(async (s) => {
        expect(s.crypto.epoch()).toBe(s.access.epoch())
        const exported = await s.crypto.exportSecret('registry-test')
        expect(exported.epoch).toBe(s.access.epoch())
        expect(exported.secret).toHaveLength(32)
        expect(() => s.crypto.exportSecret(ENTRY_SEAL_LABEL)).toThrow('reserved')
        const bytes = new Uint8Array([1, 2, 3])
        const sealed = await s.crypto.sealEntries(bytes)
        expect(await s.crypto.openEntries(sealed.sealed)).toEqual(bytes)
        const input = await s.seal()
        expect(s.crypto.frameEpoch(input.ciphertext)).toBe(s.access.epoch())
        expect(s.crypto.frameAAD(input.ciphertext)).toEqual(input.expectedAAD)
        expect(s.crypto.frameEpoch(bytes)).toBeNull()
        expect(s.crypto.frameAAD(bytes)).toBeNull()
      }))
  })
}
