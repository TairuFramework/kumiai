import type { OwnIdentity } from '@kokuin/token'
import {
  ApplicationSendRefusedError,
  bindSendCeiling,
  CommitValidationUnavailableError,
  type ControllerBinding,
  decodeClientState,
  denyApplicationSend,
  encodeClientState,
  GroupHandle,
  type HoldingToken,
  ownApplicationGeneration,
  relinquishSend,
  removeMember,
  reserveApplicationRange,
  restoreGroup,
} from '@kumiai/mls'
import * as serializer from '@kumiai/mls/testing'
import { reserveApplicationKernel, serializeHandle } from '@kumiai/mls/testing'
import { decode, encode, mlsMessageDecoder, mlsMessageEncoder, wireformats } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { buildRealRotation, createRealGroup } from './fixtures/real-group.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { memoryModel, restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`testing reservation shares the encrypt serializer / ${mode}`, async () => {
    const group = await createRealGroup(1, `reservation-seam-${mode}`)
    const local = await registryHandle({
      mode,
      handle: group.committer.handle,
      options: { resolveLedgerEntries: group.resolveLedgerEntries },
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = serializeHandle(local, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const reservation = local[reserveApplicationKernel](16)
    const encryption = local.encryptApplication(new Uint8Array([1]))
    try {
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(ownApplicationGeneration(local.state)).toBe(0)
    } finally {
      release.resolve()
      await holder
    }
    const [, frame] = await Promise.all([reservation, encryption])
    expect(frame.generation).toBe(16)
    expect((await local.encryptApplication(new Uint8Array([1]))).generation).toBe(17)
    const other = group.members[0]?.handle
    if (other == null) throw new Error('Missing peer')
    await serializeHandle(other, async (holding) => {
      await expect(local[reserveApplicationKernel](32, holding)).rejects.toThrow(TypeError)
    })
  })

  test(`removed local member cannot send, including after restore / ${mode}`, async () => {
    const group = await createRealGroup(1, `send-removal-${mode}`)
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    const options = { resolveLedgerEntries: group.resolveLedgerEntries }
    const local = await registryHandle({ mode, handle: member.handle, options })
    let commit: Uint8Array
    if (mode === 'real-mls') {
      commit = (
        await removeMember(group.committer.handle, member.handle.state.privatePath.leafIndex)
      ).commitMessage
    } else {
      const author = await registryHandle({ mode, handle: group.committer.handle, options })
      commit = memoryModel(author).buildCommit([], { removes: [member.identity.id] })
    }
    await local.processMessage(commit)
    expect(local.state.groupActiveState.kind).toBe('removedFromGroup')
    const before = encodeClientState(local.state)
    await expect(local.encrypt(new Uint8Array([1]))).rejects.toThrow()
    expect(encodeClientState(local.state)).toEqual(before)
    denyApplicationSend(local)
    await expect(reserveApplicationRange(local, { floor: 0, size: 16, cap: 500 })).rejects.toThrow()
    expect(encodeClientState(local.state)).toEqual(before)
    if (mode === 'double') {
      const restored = await restoreMemoryControlHandle({
        state: local.state,
        credential: local.credential,
        ledgerEntries: local.ledgerTokens,
        options,
      })
      expect(restored.state.groupActiveState.kind).toBe('removedFromGroup')
      await expect(restored.encrypt(new Uint8Array([1]))).rejects.toThrow()
    }
  })

  test(`unapplied self-removal proposal prevents application sends / ${mode}`, async () => {
    const group = await createRealGroup(1, `send-proposal-${mode}`)
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    await member.handle.proposeSelfRemoval()
    const local = await registryHandle({
      mode,
      handle: member.handle,
      options: { resolveLedgerEntries: group.resolveLedgerEntries },
    })
    expect(Object.keys(local.state.unappliedProposals).length).toBeGreaterThan(0)
    const before = encodeClientState(local.state)
    await expect(local.encrypt(new Uint8Array([1]))).rejects.toThrow(
      'Cannot send application message with unapplied proposals',
    )
    denyApplicationSend(local)
    await expect(reserveApplicationRange(local, { floor: 0, size: 16, cap: 500 })).rejects.toThrow()
    expect(encodeClientState(local.state)).toEqual(before)
  })
}

for (const mode of ['real-mls', 'double'] as const) {
  async function fixture() {
    const group = await createRealGroup(1, `send-policy-${mode}`)
    const options = { resolveLedgerEntries: group.resolveLedgerEntries }
    const local = await registryHandle({ mode, handle: group.committer.handle, options })
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    const peer = await registryHandle({ mode, handle: member.handle, options })
    const restore = async (bytes: Uint8Array, ledgerEntries = local.ledgerTokens) => {
      const state = decodeClientState(bytes)
      if (state == null) throw new Error('Invalid fixture state')
      return (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
        state,
        credential: local.credential,
        ledgerEntries,
        options,
      })
    }
    const commit = () =>
      mode === 'double'
        ? Promise.resolve(memoryModel(peer).buildCommit([]))
        : buildRealRotation(peer)
    return { local, peer, restore, commit }
  }

  test(`refuses, reserves and peeks without consuming / ${mode}`, async () => {
    const { local, peer, restore } = await fixture()
    bindSendCeiling(local, () => 2)
    const own = await local.encryptApplication(new Uint8Array([4]))
    expect(own.generation).toBe(0)
    expect(await local.readSenderData(own.ciphertext)).toMatchObject({ generation: 0 })
    const before = encodeClientState(peer.state)
    expect(await peer.readSenderData(own.ciphertext)).toMatchObject({ generation: 0 })
    expect(await peer.readSenderData(own.ciphertext)).toMatchObject({ generation: 0 })
    expect(encodeClientState(peer.state)).toEqual(before)
    expect((await peer.decrypt(own.ciphertext)).payload).toEqual(new Uint8Array([4]))
    await local.encrypt(new Uint8Array([5]))
    await expect(local.encrypt(new Uint8Array([6]))).rejects.toBeInstanceOf(
      ApplicationSendRefusedError,
    )
    denyApplicationSend(peer)
    await expect(peer.encrypt(new Uint8Array([1]))).rejects.toBeInstanceOf(
      ApplicationSendRefusedError,
    )
    const captured = await relinquishSend(local)
    const copy = denyApplicationSend(await restore(captured.state))
    const range = await reserveApplicationRange(copy, { floor: 40, size: 16, cap: 500 })
    expect(range).toMatchObject({ start: 40, limit: 56 })
    if (range === null) throw new Error('Missing range')
    const pre = await restore(range.pre)
    const advanced = await restore(range.advanced)
    const frame = await pre.encryptApplication(new Uint8Array([7]))
    expect(frame.generation).toBe(40)
    expect(await peer.readSenderData(frame.ciphertext)).toMatchObject({ generation: 40 })
    expect((await advanced.encryptApplication(new Uint8Array())).generation).toBe(56)
    expect(await reserveApplicationRange(copy, { floor: 490, size: 16, cap: 500 })).toMatchObject({
      start: 490,
      limit: 500,
    })
    const capped = encodeClientState(copy.state)
    expect(await reserveApplicationRange(copy, { floor: 0, size: 16, cap: 500 })).toBeNull()
    expect(encodeClientState(copy.state)).toEqual(capped)
    expect(await local.readSenderData(new Uint8Array([1]))).toBeNull()
  })

  test(`peek rejects malformed sender data and reports missing keys / ${mode}`, async () => {
    const { local, peer } = await fixture()
    const bytes = await peer.encrypt(new Uint8Array([1]))
    const decoded = decode(mlsMessageDecoder, bytes)
    if (decoded?.wireformat !== wireformats.mls_private_message) throw new Error('Missing frame')
    if (mode === 'double') {
      const frame = decoded.privateMessage
      const altered = {
        ...decoded,
        privateMessage: { ...frame, encryptedSenderData: frame.encryptedSenderData.slice(0, 4) },
      }
      expect(await local.readSenderData(encode(mlsMessageEncoder, altered))).toBeNull()
      const corrupt = {
        ...decoded,
        privateMessage: { ...frame, ciphertext: frame.ciphertext.slice() },
      }
      corrupt.privateMessage.ciphertext[0] = (corrupt.privateMessage.ciphertext[0] ?? 0) ^ 1
      expect(await local.readSenderData(encode(mlsMessageEncoder, corrupt))).toBeNull()
      Reflect.deleteProperty(local.state.keySchedule, 'resumptionPsk')
    } else {
      vi.spyOn(local.context.cipherSuite.hpke, 'decryptAead').mockRejectedValue(
        new Error('missing key'),
      )
    }
    try {
      await expect(local.readSenderData(bytes)).rejects.toBeInstanceOf(
        CommitValidationUnavailableError,
      )
    } finally {
      vi.restoreAllMocks()
    }
  })

  test(`lapsed reservations preserve state / ${mode}`, async () => {
    const { pipelineGroup, agent, lowLevelWelcome, timedBinding } = (await import(
      new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
    )) as {
      pipelineGroup(): Promise<{ group: GroupHandle }>
      agent(byte: number): OwnIdentity
      timedBinding(params: {
        identity: OwnIdentity
        iat: number
        exp: number
      }): Promise<ControllerBinding>
      lowLevelWelcome(
        group: GroupHandle,
        peer: OwnIdentity,
        binding: ControllerBinding,
      ): Promise<{ author: GroupHandle }>
    }
    vi.spyOn(Date, 'now').mockReturnValue(150_000)
    try {
      const setup = await pipelineGroup()
      const peer = agent(61)
      const { author: group } = await lowLevelWelcome(
        setup.group,
        peer,
        await timedBinding({ identity: peer, iat: 201, exp: 300 }),
      )
      const canonical = await restoreGroup({
        state: group.state,
        credential: group.credential,
        ledgerEntries: group.ledgerTokens,
      })
      const local = await registryHandle({ mode, handle: canonical, options: {} })
      denyApplicationSend(local)
      const before = encodeClientState(local.state)
      await expect(
        reserveApplicationRange(local, { floor: 0, size: 16, cap: 500 }),
      ).rejects.toThrow()
      expect(encodeClientState(local.state)).toEqual(before)
    } finally {
      vi.restoreAllMocks()
    }
  })

  test(`transfer waits for bootstrap rollback / ${mode}`, async () => {
    const fixtureGroup = await fixture()
    let local = fixtureGroup.local
    const restore = fixtureGroup.restore
    const tokens = local.ledgerTokens
    if (mode === 'real-mls') {
      local = new GroupHandle({
        state: structuredClone(local.state),
        credential: local.credential,
        context: local.context,
      })
    } else {
      const model = memoryModel(local)
      const partial = JSON.parse(new TextDecoder().decode(model.serializeState()))
      partial.ledger = []
      partial.bodies = []
      model.restoreState(new TextEncoder().encode(JSON.stringify(partial)))
    }
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const original = encodeClientState(local.state)
    const holder = local.bootstrapLedger(tokens, {
      persist: async () => {
        expect(local.ledgerTokens).toEqual(tokens)
        entered.resolve()
        await release.promise
        throw new Error('rollback')
      },
    })
    const rejected = expect(holder).rejects.toThrow('rollback')
    await entered.promise
    let settled = false
    const transfer = relinquishSend(local).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await rejected
    const captured = await transfer
    expect(captured.state).toEqual(original)
    expect(captured.ledgerTokens).toEqual([])
    const copy = denyApplicationSend(await restore(captured.state, captured.ledgerTokens))
    expect(await reserveApplicationRange(copy, { floor: 0, size: 16, cap: 500 })).toMatchObject({
      start: 0,
    })
  })

  test(`transfer waits for decrypt and captures receive progress / ${mode}`, async () => {
    const { local, peer } = await fixture()
    const frame = await peer.encrypt(new Uint8Array([1]))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = local.decryptStaged(frame, {}, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    let settled = false
    const transfer = relinquishSend(local).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await holder
    expect((await transfer).state).toEqual(encodeClientState(local.state))
  })

  test(`double and real encrypt share the built serializer / ${mode}`, async () => {
    const { local, restore } = await fixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const holder = serializeHandle(local, async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const send = local.encryptApplication(new Uint8Array([1]))
    let settled = false
    const transfer = relinquishSend(local).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await holder
    await expect(send).rejects.toBeInstanceOf(ApplicationSendRefusedError)
    const captured = await transfer
    expect(
      (await (await restore(captured.state)).encryptApplication(new Uint8Array())).generation,
    ).toBe(0)
  })

  if (mode === 'double') {
    test('an admitted double encrypt holds the built serializer until completion', async () => {
      const { local, restore } = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const original = serializer.serializeHandle
      const spy = vi.spyOn(serializer, 'serializeHandle').mockImplementation((handle, fn) =>
        original(handle, async (holding) => {
          const result = await fn(holding)
          entered.resolve()
          await release.promise
          return result
        }),
      )
      try {
        const send = local.encryptApplication(new Uint8Array([1]))
        await Promise.race([
          entered.promise,
          send.then(() => {
            throw new Error('Encrypt bypassed the built serializer')
          }),
        ])
        let settled = false
        const transfer = relinquishSend(local).then((value) => {
          settled = true
          return value
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        release.resolve()
        expect((await send).generation).toBe(0)
        expect(
          (await (await restore((await transfer).state)).encryptApplication(new Uint8Array()))
            .generation,
        ).toBe(1)
      } finally {
        release.resolve()
        spy.mockRestore()
      }
    })
  }

  for (const callback of ['bootstrap', 'process'] as const) {
    test(`holding token is valid only inside ${callback} persist / ${mode}`, async () => {
      const { local, peer, restore, commit } = await fixture()
      let saved: HoldingToken | undefined
      const persist = async (handle: GroupHandle, { holding }: { holding: HoldingToken }) => {
        saved = holding
        await expect(relinquishSend(peer, { holding })).rejects.toThrow(TypeError)
        const captured = await relinquishSend(handle, { holding })
        const copy = denyApplicationSend(await restore(captured.state))
        expect(await reserveApplicationRange(copy, { floor: 0, size: 16, cap: 500 })).toMatchObject(
          { start: 0, limit: 16 },
        )
      }
      if (callback === 'bootstrap') await local.bootstrapLedger(local.ledgerTokens, { persist })
      else await local.processMessage(await commit(), { persist })
      await expect(relinquishSend(local, { holding: saved })).rejects.toThrow(TypeError)
    })

    test(`without holding token transfer waits inside ${callback} persist / ${mode}`, async () => {
      const { local, commit } = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let transfer: Promise<unknown> | undefined
      let settled = false
      const persist = async () => {
        transfer = relinquishSend(local).then(() => {
          settled = true
        })
        entered.resolve()
        await release.promise
      }
      const bytes = callback === 'process' ? await commit() : null
      vi.useFakeTimers()
      try {
        const holder =
          bytes === null
            ? local.bootstrapLedger(local.ledgerTokens, { persist })
            : local.processMessage(bytes, { persist })
        await entered.promise
        await vi.advanceTimersByTimeAsync(50)
        expect(settled).toBe(false)
        release.resolve()
        await holder
        await transfer
        expect(settled).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  }
}
