import { randomIdentity } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  processWelcome,
} from '@kumiai/mls'
import { appFrameIdempotencyKey, encodeAppAAD, frameID } from '@kumiai/rpc'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import { createClearReportedHold } from '../src/clear-hold.js'
import { entryCapability } from '../src/entry-capability.js'
import type { OpenAppInput } from '../src/persistence-types.js'
import { registrySafety } from '../src/registry/safety.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureBumpStateVersion,
  registryFixtureMutateAppCursor,
} from './fixtures/registry.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { nextChange } from './fixtures/storage-seed.js'

async function setup(mode: 'real-mls' | 'double') {
  let f = await createRegistryFixture({ mode, setup: 'empty', groupID: `open-batch-${mode}` })
  const remote = randomIdentity()
  const options = f.environment.options ?? {}
  const base = (await createGroup(f.identity, `open-batch-${mode}`, options)).group
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
    { packageUse: { sourceID: 'app-open', ref: 'joined', kind: 'ordinary' } },
  )
  let access = await f.registry.access(key.groupID)
  const entry = () => {
    const value = entryCapability(f.device.groups)
    if (value === null) throw new Error('Missing capability')
    return value
  }
  return {
    get f() {
      return f
    },
    get access() {
      return access
    },
    key,
    sender,
    senderDID: remote.id,
    entry,
    async seal(
      position: number | string,
      payload = encodeEventFrame('posted', { text: 'hello' }),
      topicID = 'app-X',
    ): Promise<OpenAppInput> {
      const ciphertext = await sender.encrypt(payload, {
        aad: encodeAppAAD({ topicID, intent: 'log' }),
      })
      return {
        frame: {
          ...key,
          id: frameID(topicID, ciphertext),
          protocol: 'chat',
          topicID,
          segment: access.epoch(),
          position: typeof position === 'number' ? String(position).padStart(12, '0') : position,
        },
        ciphertext,
        expectedAAD: encodeAppAAD({ topicID, intent: 'log' }),
      }
    },
    async snapshot() {
      return {
        revision: (await entry().read(key.groupID, (reads) => reads.lifetime()))?.revision,
        state: await f.device.groups.loadState(key),
        rows: await f.inspectRows(),
      }
    },
    async saved(id: string) {
      return entry().read(key.groupID, (reads) => reads.appFrame(key.incarnation, id))
    },
    async cursor(position: string, topicID = 'app-X') {
      await f.device.groups.transition(
        await nextChange(f.device.groups, key.groupID, crypto.randomUUID()),
        (stores) => stores.incarnation(key.incarnation).cursor.save(topicID, position),
      )
    },
    async advance() {
      const { candidate, expected, write } = await f.acceptedOrdinary(access)
      expect(await access.adopt(candidate, expected, write)).toBe('installed')
    },
    async restart() {
      f = await f.reopen()
      access = await f.registry.access(key.groupID)
    },
    async close() {
      await f.close()
    },
  }
}

type Setup = Awaited<ReturnType<typeof setup>>
async function held(f: RegistryFixture, key: Setup['key']) {
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
  const halt = (await f.device.groups.ports(key).control.load()).forkHalt
  if (halt === null) throw new Error('Missing reported hold')
  return halt
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`registry open batch / ${mode}`, () => {
    const run = async (fn: (s: Setup) => Promise<void>) => {
      const s = await setup(mode)
      try {
        await fn(s)
      } finally {
        await s.close()
      }
    }

    test('mixed batch commits once in input order', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const b = await s.seal(2, fromUTF('{}'))
        const c = await s.seal(3)
        const d = await s.seal(4)
        c.expectedAAD = encodeAppAAD({ topicID: 'app-Y', intent: 'log' })
        const before = await s.snapshot()
        const results = await s.access.openBatch([a, b, c, d])
        expect(results).toMatchObject([
          { kind: 'opened' },
          { kind: 'refused', reason: 'malformed-plaintext', keyConsumed: true },
          { kind: 'refused', reason: 'wrong-aad', keyConsumed: false },
          { kind: 'opened' },
        ])
        const after = await s.snapshot()
        expect(after.revision).toBe((before.revision ?? 0) + 1)
        expect(after.state?.version).toBe((before.state?.version ?? 0) + 1)
        const saved = await s.saved(a.frame.id)
        expect(saved.pending).toMatchObject({
          frame: { ...a.frame, procedure: 'posted' },
          epoch: s.access.epoch(),
          senderDID: s.senderDID,
        })
        expect(saved.pending?.idempotencyKey).toBe(
          appFrameIdempotencyKey({ ...a.frame, procedure: 'posted' }),
        )
        expect((await s.saved(d.frame.id)).pending).not.toBeNull()
        expect((await s.saved(b.frame.id)).poison).toEqual({
          frame: b.frame,
          reason: 'malformed-plaintext',
          keyConsumed: true,
        })
      }))

    test('refused and held inputs commit no transition', () =>
      run(async (s) => {
        const past = await s.seal(1)
        for (let i = 0; i < 5; i++) await s.advance()
        const future = await s.seal(3)
        // A sender ahead of the receiver supplies a real future-epoch frame.
        const advanced = await s.f.advance(await s.access.read((handle) => handle))
        future.ciphertext = await advanced.encrypt(encodeEventFrame('posted'), {
          aad: future.expectedAAD,
        })
        future.frame.id = frameID(future.frame.topicID, future.ciphertext)
        const junk = {
          ...past,
          frame: {
            ...past.frame,
            id: frameID(past.frame.topicID, new Uint8Array([1, 2, 3])),
            position: '000000000002',
          },
          ciphertext: new Uint8Array([1, 2, 3]),
        }
        const before = await s.snapshot()
        expect(await s.access.openBatch([junk, past, future])).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          { kind: 'refused', reason: 'past-epoch', keyConsumed: false },
          {
            kind: 'held',
            reason: 'future-epoch',
            frameEpoch: s.access.epoch() + 1,
            handleEpoch: s.access.epoch(),
          },
        ])
        expect(await s.snapshot()).toEqual(before)
      }))

    test('retained past epoch opens', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const epoch = s.access.epoch()
        await s.advance()
        const [opened] = await s.access.openBatch([a])
        expect(opened).toMatchObject({ kind: 'opened', handleEpoch: epoch + 1, record: { epoch } })
        await s.advance()
        await s.restart()
        const before = await s.snapshot()
        expect(await s.access.openBatch([a])).toEqual([{ ...opened, handleEpoch: epoch + 2 }])
        expect(await s.snapshot()).toEqual(before)
      }))

    test('wrong-topic sibling burns no generation and valid siblings open', () =>
      run(async (s) => {
        const f = await s.seal(1)
        const g = await s.seal(2)
        const wrong = {
          ...f,
          frame: { ...f.frame, id: frameID('app-Y', f.ciphertext), topicID: 'app-Y' },
          expectedAAD: encodeAppAAD({ topicID: 'app-Y', intent: 'log' }),
        }
        expect(await s.access.openBatch([wrong, g])).toMatchObject([
          { kind: 'refused', reason: 'wrong-aad', keyConsumed: false },
          { kind: 'opened' },
        ])
        expect(await s.access.openBatch([f])).toMatchObject([{ kind: 'opened' }])
      }))

    test('substituted ciphertext cannot claim an unseen frame id or consume either key', () =>
      run(async (s) => {
        const first = encodeEventFrame('posted', { text: 'first' })
        const second = encodeEventFrame('posted', { text: 'second' })
        const c1 = await s.seal(1, first)
        const c2 = await s.seal(2, second)
        const substituted = { ...c1, ciphertext: c2.ciphertext }
        const before = await s.snapshot()
        expect(await s.access.openBatch([substituted])).toEqual([
          {
            kind: 'refused',
            frame: c1.frame,
            reason: 'invalid-ciphertext',
            keyConsumed: false,
          },
        ])
        expect(await s.snapshot()).toEqual(before)
        for (const [input, payload] of [
          [c1, first],
          [c2, second],
        ] as const) {
          expect(await s.access.openBatch([input])).toMatchObject([
            {
              kind: 'opened',
              record: {
                frame: input.frame,
                payload,
                idempotencyKey: appFrameIdempotencyKey({ ...input.frame, procedure: 'posted' }),
              },
            },
          ])
        }
        expect(await s.access.pending.list()).toHaveLength(2)
      }))

    test('frame id validation precedes in-batch and saved replay without shadowing valid inputs', () =>
      run(async (s) => {
        const c1 = await s.seal(1)
        const c2 = await s.seal(2)
        const substituted = { ...c1, ciphertext: c2.ciphertext }
        expect(await s.access.openBatch([substituted, c1, substituted, c2])).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          { kind: 'opened', record: { frame: c1.frame } },
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
          { kind: 'opened', record: { frame: c2.frame } },
        ])
        const before = await s.snapshot()
        expect(await s.access.openBatch([substituted])).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
        ])
        expect(await s.snapshot()).toEqual(before)
      }))

    test('duplicate frame in one batch yields one pending record', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const results = await s.access.openBatch([a, a])
        expect(results[0]).toEqual(results[1])
        expect(await s.access.pending.list()).toHaveLength(1)
      }))

    test('same ciphertext at another position refuses as duplicate', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const other = { ...a, frame: { ...a.frame, position: '000000000005' } }
        expect(await s.access.openBatch([a, other])).toMatchObject([
          { kind: 'opened' },
          { kind: 'refused', reason: 'duplicate', keyConsumed: false },
        ])
        const before = await s.snapshot()
        expect(await s.access.openBatch([other])).toMatchObject([
          { kind: 'refused', reason: 'duplicate' },
        ])
        expect(await s.snapshot()).toEqual(before)
      }))

    test('same id at another segment refuses as duplicate', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const other = { ...a, frame: { ...a.frame, segment: a.frame.segment + 1 } }
        expect(await s.access.openBatch([a, other])).toMatchObject([
          { kind: 'opened' },
          { kind: 'refused', reason: 'duplicate' },
        ])
        expect(await s.access.openBatch([other])).toMatchObject([
          { kind: 'refused', reason: 'duplicate' },
        ])
      }))

    test('saved rows resolve on exact occurrence match', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const b = await s.seal(2, fromUTF('{}'))
        const results = await s.access.openBatch([a, b])
        const before = await s.snapshot()
        expect(await s.access.openBatch([a, b])).toEqual(results)
        expect(await s.snapshot()).toEqual(before)
      }))

    test('completed frame refetch refuses without a write', () =>
      run(async (s) => {
        const a = await s.seal(1)
        await s.access.openBatch([a])
        await s.access.pending.complete(a.frame.id)
        const before = await s.snapshot()
        expect(await s.access.openBatch([a])).toMatchObject([
          { kind: 'refused', reason: 'invalid-ciphertext', keyConsumed: false },
        ])
        expect(await s.snapshot()).toEqual(before)
      }))

    test.each([
      ['A', 'B', 'C'],
      ['000000000001', '000000000002', '000000000003'],
    ])('occurrence behind durable cursor refuses before decryption: %s', (a, b, c) =>
      run(async (s) => {
        for (const restart of [false, true]) {
          const frame = await s.seal(a)
          await s.cursor(b)
          if (restart) await s.restart()
          const before = await s.snapshot()
          expect(await s.access.openBatch([frame])).toMatchObject([
            { kind: 'refused', reason: 'duplicate', keyConsumed: false },
          ])
          expect(await s.snapshot()).toEqual(before)
          expect(
            await s.access.openBatch([{ ...frame, frame: { ...frame.frame, position: c } }]),
          ).toMatchObject([{ kind: 'opened' }])
        }
      }),
    )

    test('cursor moved between prepare and work re-prepares', () =>
      run(async (s) => {
        const a = await s.seal(2)
        await s.cursor('000000000001')
        s.f.onPhase('before-work', () =>
          registryFixtureMutateAppCursor(s.f, s.key, 'app-X', '000000000003'),
        )
        const version = s.access.stateVersion()
        const before = await s.snapshot()
        expect(await s.access.openBatch([a])).toMatchObject([
          { kind: 'refused', reason: 'duplicate', keyConsumed: false },
        ])
        expect(s.access.stateVersion()).toBe(version)
        expect((await s.snapshot()).revision).toBe(before.revision)
        expect(await s.saved(a.frame.id)).toEqual({ pending: null, poison: null })
      }))

    test('invalid position refuses that input only', () =>
      run(async (s) => {
        const a = await s.seal('')
        const b = await s.seal('x'.repeat(65))
        const c = await s.seal(3)
        expect(await s.access.openBatch([a, b, c])).toMatchObject([
          { kind: 'refused', reason: 'invalid-position' },
          { kind: 'refused', reason: 'invalid-position' },
          { kind: 'opened' },
        ])
      }))

    test.each([1, 3])('receive save conflict re-prepares with %s bumps', (bumps) =>
      run(async (s) => {
        const a = await s.seal(1)
        let count = 0
        const bump = async () => {
          count++
          await registryFixtureBumpStateVersion(s.f, s.key)
          if (count < bumps) s.f.onPhase('before-work', bump)
        }
        s.f.onPhase('before-work', bump)
        if (bumps === 1) expect(await s.access.openBatch([a])).toMatchObject([{ kind: 'opened' }])
        else
          await expect(s.access.openBatch([a])).rejects.toMatchObject({
            name: 'GroupStateConflictError',
          })
        expect(count).toBe(bumps)
        expect(await s.access.pending.list()).toHaveLength(bumps === 1 ? 1 : 0)
      }),
    )

    test('safety hold rejects the whole batch', () =>
      run(async (s) => {
        const a = await s.seal(1)
        await held(s.f, s.key)
        const before = await s.snapshot()
        await expect(s.access.openBatch([a])).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
        })
        expect(await s.snapshot()).toEqual(before)
      }))

    test('safety hold latched after prepare rejects work until authorised clearance', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const halt = await held(s.f, s.key)
        const clear = createClearReportedHold({
          registry: s.f.registry,
          persistence: s.f.device.groups,
        })
        await clear(s.key)
        const safety = registrySafety(s.f.registry)
        if (safety === null) throw new Error('Missing safety capability')
        const before = await s.snapshot()
        s.f.onPhase('before-work', () => safety.reportHold(s.key, halt))
        await expect(s.access.openBatch([a])).rejects.toMatchObject({
          name: 'GroupSafetyHeldError',
        })
        expect(await s.snapshot()).toEqual(before)
        await held(s.f, s.key)
        await clear(s.key)
        expect(await s.access.openBatch([a])).toMatchObject([
          { kind: 'opened', record: { frame: a.frame } },
        ])
        expect(await s.access.pending.list()).toHaveLength(1)
      }))

    test('empty batch and batch bound perform no reads', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const reads = s.f.coldLoadCount(s.key.groupID)
        const before = await s.snapshot()
        const spy = vi.spyOn(s.entry(), 'run')
        expect(await s.access.openBatch([])).toEqual([])
        await expect(
          s.access.openBatch(Array.from({ length: 65 }, () => a)),
        ).rejects.toBeInstanceOf(RangeError)
        expect(spy).not.toHaveBeenCalled()
        expect(s.f.coldLoadCount(s.key.groupID)).toBe(reads)
        expect(await s.snapshot()).toEqual(before)
      }))

    test('foreign incarnation key rejects before any read', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const before = await s.snapshot()
        const reads = s.f.coldLoadCount(s.key.groupID)
        const spy = vi.spyOn(s.entry(), 'run')
        await expect(
          s.access.openBatch([{ ...a, frame: { ...a.frame, incarnation: 2 } }]),
        ).rejects.toMatchObject({ name: 'DisplacedGroupHandleError' })
        expect(spy).not.toHaveBeenCalled()
        expect(s.f.coldLoadCount(s.key.groupID)).toBe(reads)
        expect(await s.snapshot()).toEqual(before)
      }))

    test('public registry.access() exposes openBatch and pending', () =>
      run(async (s) => {
        expect(typeof s.access.openBatch).toBe('function')
        expect(s.access.pending).toBeDefined()
        const a = await s.seal(1)
        const [result] = await s.access.openBatch([a])
        expect(result?.kind).toBe('opened')
        expect(await s.access.pending.list()).toEqual(
          result?.kind === 'opened' ? [result.record] : [],
        )
      }))

    test('concurrent same-id openers commit one pending record and no poison', () =>
      run(async (s) => {
        const a = await s.seal(1)
        const before = await s.snapshot()
        const results = await Promise.all([s.access.openBatch([a]), s.access.openBatch([a])])
        expect(results[0]).toMatchObject([{ kind: 'opened' }])
        expect(results[1]).toEqual(results[0])
        expect(await s.access.pending.list()).toHaveLength(1)
        expect((await s.saved(a.frame.id)).poison).toBeNull()
        expect((await s.snapshot()).revision).toBe((before.revision ?? 0) + 1)
      }))

    test('pending lists in comparator order and completes idempotently without app safety', () =>
      run(async (s) => {
        const a = await s.seal(2)
        const b = await s.seal(1)
        const c = await s.seal(3, fromUTF('{}'))
        a.frame.segment += 1
        await s.access.openBatch([a, b, c])
        await held(s.f, s.key)
        const version = s.access.stateVersion()
        const listed = await s.access.pending.list()
        expect(listed.map((record) => record.frame.id)).toEqual([b.frame.id, a.frame.id])
        const first = listed[0]
        if (first === undefined) throw new Error('Missing frame')
        first.payload.fill(0)
        first.frame.position = 'changed'
        first.idempotencyKey = 'changed'
        expect((await s.access.pending.list())[0]?.frame.position).toBe('000000000001')
        await s.access.pending.complete(a.frame.id)
        await s.access.pending.complete(c.frame.id)
        expect((await s.saved(c.frame.id)).poison).toBeNull()
        const before = await s.snapshot()
        await s.access.pending.complete(a.frame.id)
        await s.access.pending.complete('unknown')
        expect(await s.snapshot()).toEqual(before)
        expect(s.access.stateVersion()).toBe(version)
        expect(await s.access.pending.list()).toHaveLength(1)
      }))
  })
}
