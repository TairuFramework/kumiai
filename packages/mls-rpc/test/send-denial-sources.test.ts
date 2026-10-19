import type * as Mls from '@kumiai/mls'
import {
  ApplicationSendRefusedError,
  bindSendCeiling,
  encodeClientState,
  type GroupHandle,
} from '@kumiai/mls'
import { describe, expect, test, vi } from 'vitest'

import { entryCapability } from '../src/entry-capability.js'
import { loadValidatedGroup } from '../src/registry/cold.js'
import { accessKinds, authoringAccessFixture, rotationIntent } from './fixtures/authoring-access.js'
import {
  createCapturedRealRecovery,
  createForkRecoveryRealFixture,
} from './fixtures/captured-recovery.js'
import { createRegistryFixture, registryFixtureRestore } from './fixtures/registry.js'

const recoveryHandles = vi.hoisted(() => [] as Array<GroupHandle>)
vi.mock('@kumiai/mls', async (importOriginal) => {
  const actual = await importOriginal<typeof Mls>()
  return {
    ...actual,
    async restoreGroup(...args: Parameters<typeof Mls.restoreGroup>) {
      const handle = await actual.restoreGroup(...args)
      recoveryHandles.push(handle)
      return handle
    },
    async joinGroupExternal(...args: Parameters<typeof Mls.joinGroupExternal>) {
      const joined = await actual.joinGroupExternal(...args)
      recoveryHandles.push(joined.group)
      return joined
    },
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  describe(`accepted handle denial (${mode})`, () => {
    test('even an invalid seed relinquishes before its refusal', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: 'denial' })
      try {
        const input = await fixture.makeHandle(0)
        await expect(
          fixture.registry.seed(input, {
            packageUse: { sourceID: 'source', ref: 'ref', kind: 'ordinary' },
          }),
        ).rejects.toMatchObject({ reason: 'invalid-genesis' })
        await expect(input.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
        expect(() => bindSendCeiling(input, () => 16)).toThrow(TypeError)
      } finally {
        await fixture.close()
      }
    })
    test('every handle handed to host code is denied through read, mutate, readControl, refresh and replacement prepare', async () => {
      const fixture = await createRegistryFixture({
        mode,
        setup: 'seeded',
        groupID: 'issued-denial',
      })
      try {
        const access = await fixture.registry.access('issued-denial')
        const handles = [
          await access.read((handle) => handle),
          await access.mutate(async (handle) => handle),
          ...(await access.readControl(async ({ handle, refresh }) => [
            handle,
            (await refresh()).handle,
          ])),
        ]
        const { candidate, write } = await fixture.acceptedOrdinary(access)
        const prepared = vi.fn(async (current: GroupHandle) => {
          handles.push(current)
          return true
        })
        await access.replace(candidate, () => write, prepared)
        expect(prepared).toHaveBeenCalledOnce()
        for (const handle of handles) {
          await expect(handle.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
            ApplicationSendRefusedError,
          )
          expect(() => bindSendCeiling(handle, () => 16)).toThrow(TypeError)
        }
      } finally {
        await fixture.close()
      }
    })
    test('cold validation denies its internal restored handle', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'seeded', groupID: 'cold-denial' })
      try {
        const capability = entryCapability(fixture.device.groups)
        if (capability === null) throw new Error('Missing entry capability')
        const restored: Array<GroupHandle> = []
        const restore = registryFixtureRestore(fixture)
        await capability.read('cold-denial', (reads) =>
          loadValidatedGroup(reads, 'cold-denial', null, {
            ownerDID: fixture.identity.id,
            recovery: fixture.environment,
            restore: async (record) => {
              const handle = await restore(record)
              restored.push(handle)
              return handle
            },
          }),
        )
        expect(restored).toHaveLength(1)
        for (const handle of restored) {
          await expect(handle.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
            ApplicationSendRefusedError,
          )
          expect(() => bindSendCeiling(handle, () => 16)).toThrow(TypeError)
        }
      } finally {
        await fixture.close()
      }
    })
    test('already joined seed relinquishes its input', async () => {
      const fixture = await createRegistryFixture({ mode, setup: 'empty', groupID: 'denial' })
      try {
        const history = await fixture.welcomeHistory('ordinary')
        await fixture.registry.seed(history.exact, { packageUse: history.packageUse })
        await fixture.registry.seed(history.newer, {
          replace: true,
          packageUse: history.packageUse,
        })
        await fixture.registry.seed(history.unusedOlder, { packageUse: history.packageUse })
        await expect(history.unusedOlder.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
          ApplicationSendRefusedError,
        )
        expect(() => bindSendCeiling(history.unusedOlder, () => 16)).toThrow(TypeError)
      } finally {
        await fixture.close()
      }
    })
  })
}

for (const kind of accessKinds) {
  test(`control-build permit clones refuse application sending for ${kind} hosts`, async () => {
    const f = await authoringAccessFixture(kind)
    try {
      await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
      let checked = false
      const result = await f
        .port(async (operation, source) => {
          await expect(source.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
            ApplicationSendRefusedError,
          )
          expect(() => bindSendCeiling(source, () => 16)).toThrow(TypeError)
          checked = true
          return f.build(operation, source)
        })
        .prepareBuild(rotationIntent, async (built) => ({
          payload: built.commit,
          publishID: 'publish',
          expectedHead: null,
        }))
      expect(result.kind).toBe('saved')
      expect(checked).toBe(true)
    } finally {
      await f.close()
    }
  })
}

test('simple access keeps read, mutate and replacement handles send-capable', async () => {
  const f = await authoringAccessFixture('simple')
  try {
    await f.access.read(async (handle) => {
      await expect(handle.encrypt(new Uint8Array([1]))).resolves.toBeInstanceOf(Uint8Array)
    })
    await f.access.mutate(async (handle, persist) => {
      await persist(handle)
      await expect(handle.encrypt(new Uint8Array([2]))).resolves.toBeInstanceOf(Uint8Array)
    })
    const next = await f.access.read((handle) => f.restoreStored(encodeClientState(handle.state)))
    await f.access.replace(next)
    await expect(next.encrypt(new Uint8Array([3]))).resolves.toBeInstanceOf(Uint8Array)
  } finally {
    await f.close()
  }
})

for (const restored of [false, true]) {
  test(`simple control adoption preserves sending after reconstruction: ${restored}`, async () => {
    const f = await authoringAccessFixture('simple')
    try {
      expect((await f.owe()).kind).toBe('saved')
      const slot = (await f.control().load()).commitOnce
      if (slot === null) throw new Error('Missing control slot')
      const source = await f.access.readControl(async ({ source }) => source)
      const { asLogPosition } = await import('@kumiai/rpc')
      const proof = {
        source,
        from: slot.searchFrom,
        position: asLogPosition('00001'),
        payloadDigest: slot.payloadDigest,
      }
      await f.control().apply({ commitOnceAcceptance: proof }, 'accepted')
      if (restored) await f.reconstruct()
      const { createControlAdoptionPort } = await import('../src/control-adoption.js')
      const port = createControlAdoptionPort({
        access: f.access,
        control: f.control(),
        restoreCandidate: f.restoreCandidate,
      })
      const expected = {
        ...(await f.access.readControl(async ({ source }) => source)),
        acceptance: proof,
      }
      expect(
        await port.adopt(slot.journal, expected, {
          mutationID: 'adopted',
          changes: { commitOnce: null },
        }),
      ).toBe('installed')
      await f.access.read(async (handle) => {
        await expect(handle.encrypt(new Uint8Array([1]))).resolves.toBeInstanceOf(Uint8Array)
      })
    } finally {
      await f.close()
    }
  })
}

for (const registryBacked of [false, true]) {
  test(`fresh and restored recovery send policy follows registry ownership: ${registryBacked}`, async () => {
    const fork = registryBacked ? await createForkRecoveryRealFixture(true) : null
    const simple = registryBacked ? null : await createCapturedRealRecovery(false)
    try {
      const requester = fork?.requester() ?? simple?.requester
      const port = requester?.capturedRecovery
      if (port === undefined) throw new Error('Missing recovery port')
      let capture: { sealed: Uint8Array; requestID: string; requestKey: Uint8Array }
      if (fork !== null) {
        const reply = await fork.reply()
        capture = reply
        const authority = await port.authoriseForkRecovery?.(reply, fork.noticeID)
        if (authority == null) throw new Error('Missing recovery authority')
      } else {
        if (simple === null || requester === undefined) throw new Error('Missing simple host')
        const requestID = 'simple-denial'
        const { request, requestKey } = await requester.createRecoveryRequest(requestID)
        const sealed = await simple.responder.sealGroupInfo(request, null)
        if (sealed === null) throw new Error('Missing recovery reply')
        capture = { sealed, requestID, requestKey }
      }
      let before = recoveryHandles.length
      const pending = await port.applyRecovery(
        capture.sealed,
        capture.requestID,
        capture.requestKey,
      )
      if (pending === null || 'renewalRequired' in pending)
        throw new Error('Missing recovery candidate')
      const saved = pending.serialize()
      const fresh = recoveryHandles
        .slice(before)
        .findLast((handle) => Number(handle.epoch) === pending.epoch)
      if (fresh === undefined) throw new Error('Missing fresh recovery handle')
      before = recoveryHandles.length
      const restored = await port.restoreRecovery(saved, capture.requestKey)
      if (restored === null) throw new Error('Missing restored recovery')
      const restoredHandle = recoveryHandles
        .slice(before)
        .findLast((handle) => Number(handle.epoch) === restored.epoch)
      if (restoredHandle === undefined) throw new Error('Missing restored recovery handle')
      for (const handle of [fresh, restoredHandle]) {
        if (registryBacked) {
          await expect(handle.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
            ApplicationSendRefusedError,
          )
          expect(() => bindSendCeiling(handle, () => 16)).toThrow(TypeError)
        } else {
          await expect(handle.encrypt(new Uint8Array([1]))).resolves.toBeInstanceOf(Uint8Array)
        }
      }
    } finally {
      await fork?.close()
    }
  })
}

test('a prepare refusal leaves speculative control notifications queued', async () => {
  const {
    commitLedgerEntries,
    restoreGroup,
    signLedgerEntry,
    verifyLedgerEntry,
    ledgerEntryDigest,
  } = await import('@kumiai/mls')
  const { createRegistryHandleAccess } = await import('../src/registry-handle-access.js')
  const emitted: Array<string> = []
  const fixture = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'seeded',
    groupID: 'refused-notifications',
  })
  try {
    const registryAccess = await fixture.registry.access('refused-notifications')
    const raw = await registryAccess.read((handle) =>
      restoreGroup({
        state: structuredClone(handle.state),
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
        options: fixture.environment.options,
      }),
    )
    const token = await signLedgerEntry(fixture.identity, {
      type: 'app.notification',
      groupID: 'refused-notifications',
      subject: fixture.identity.id,
      value: 'queued',
    })
    emitted.length = 0
    const candidate = (await commitLedgerEntries(raw, [token])).newGroup
    const headDigest = ledgerEntryDigest(token)
    const beaconToken = await signLedgerEntry(fixture.identity, {
      type: 'kumiai.device',
      groupID: 'refused-notifications',
      subject: fixture.identity.id,
      value: { op: 'beacon', logLength: 1, headDigest },
    })
    const beacon = await verifyLedgerEntry(beaconToken)
    if (beacon === null) throw new Error('Invalid beacon')
    candidate.events.on('controllerBeaconChanged', (value) => {
      emitted.push(value.headDigest)
    })
    candidate.emitControlEvents([beacon])
    expect(emitted).toEqual([])
    const before = await fixture.inspectRows()
    await createRegistryHandleAccess({ access: registryAccess }).replace(
      candidate,
      undefined,
      async () => false,
    )
    expect(emitted).toEqual([])
    expect(await fixture.inspectRows()).toEqual(before)
    candidate.confirmAdopted()
    expect(emitted).toEqual([headDigest])
  } finally {
    await fixture.close()
  }
})
