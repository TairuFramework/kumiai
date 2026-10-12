import { randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  computeHead,
  createGroup,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  type GroupOptions,
  ledgerEntryDigest,
  readGroupAnchorExtension,
  readLedgerHead,
  readLedgerHeadExtension,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import { describe, expect, test } from 'vitest'

import { encodeStoredValue } from '../src/persistence-codec.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { validateRegistryHandle } from '../src/registry/validation.js'
import {
  buildSealedMemoryOperation,
  memoryModel,
  restoreMemoryControlHandle,
  seedMemoryControlState,
} from './fixtures/sealed-memory-mls.js'

async function setup(options: GroupOptions = {}) {
  const identity = randomIdentity()
  const { group } = await createGroup(identity, 'registry-double', options)
  const token = await signLedgerEntry(identity, {
    type: 'kumiai.role',
    groupID: group.groupID,
    subject: identity.id,
    value: 'admin',
  })
  const state = seedMemoryControlState(group.state, group.credential, [token, token])
  const handle = await restoreMemoryControlHandle({
    state,
    credential: group.credential,
    ledgerEntries: [token, token],
    options,
  })
  return { identity, handle, token, options }
}

async function candidate(handle: GroupHandle, options: GroupOptions = {}) {
  const built = await buildSealedMemoryOperation(
    {
      id: 'ordinary',
      kind: 'invite',
      revokes: false,
      seq: 1,
      enqueuedAt: 0,
      deadline: 1000,
      stage: 'intent',
      body: encodeStoredValue({ target: handle.credential.id }),
    },
    handle,
  )
  const state = decodeClientState(built.journal)
  if (state === undefined) throw new Error('Missing candidate state')
  return restoreMemoryControlHandle({
    state,
    credential: handle.credential,
    ledgerEntries: handle.ledgerTokens,
    options,
  })
}

describe('independent registry handle', () => {
  test.each(['floating', 'bound'])(
    'signed model enactment projects ledger and control facts live and after reconstruction (%s)',
    async (mode) => {
      const { bindingFor } = (await import(
        new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
      )) as {
        bindingFor(identity: ReturnType<typeof randomIdentity>): Promise<ControllerBinding>
      }
      const identity = randomIdentity()
      const binding = await bindingFor(identity)
      const { group } = await createGroup(
        identity,
        'signed-model-ledger',
        mode === 'bound' ? { controller: binding } : {},
      )
      const handle = await restoreMemoryControlHandle({
        state: seedMemoryControlState(group.state, group.credential),
        credential: group.credential,
        ledgerEntries: [],
      })
      const subject = randomIdentity().id
      const beacon = await signLedgerEntry(identity, {
        type: 'kumiai.device',
        groupID: group.groupID,
        subject: binding.id,
        value: {
          op: 'beacon',
          logLength: binding.prefix.length,
          headDigest: 'signed-model-beacon',
        },
      })
      const role = await signLedgerEntry(identity, {
        type: 'kumiai.role',
        groupID: group.groupID,
        subject,
        value: 'admin',
      })
      const tokens = mode === 'bound' ? [beacon, beacon] : [role, role]
      const mls = memoryModel(handle)
      await mls.adopt(mls.buildCommit(tokens))
      const assertProjection = async (current: GroupHandle) => {
        expect(await memoryModel(current).getLedger()).toEqual(tokens)
        expect(current.ledgerTokens).toEqual(tokens)
        expect(current.ledger.map(({ entryID }) => entryID)).toEqual(tokens.map(ledgerEntryDigest))
        expect(readLedgerHead(current)?.head).toEqual(
          computeHead(current.groupID, tokens.map(ledgerEntryDigest)),
        )
        expect(await current.isLedgerComplete()).toBe(true)
        expect(await memoryModel(current).isLedgerComplete()).toBe(true)
        const reference = await restoreGroup({
          state: current.state,
          credential: current.credential,
          ledgerEntries: tokens,
        })
        expect(current.roster).toEqual(reference.roster)
        if (mode === 'floating') expect(current.roster.roles.get(subject)).toBe('admin')
        expect(current.registry).toEqual(reference.registry)
        if (mode === 'bound')
          expect(current.registry.controllers.get(binding.id)?.beacon).toEqual({
            logLength: binding.prefix.length,
            headDigest: 'signed-model-beacon',
          })
        const key = { groupID: current.groupID, incarnation: 1 }
        const facts = recoveryTrustFor(current, key, null)
        expect(facts).toEqual(recoveryTrustFor(reference, key, null))
        expect(facts.ledger).toEqual(await memoryModel(current).getLedger())
        return facts
      }
      const facts = await assertProjection(handle)
      const bytes = encodeClientState(handle.state)
      const state = decodeClientState(bytes)
      if (state === undefined) throw new Error('Missing signed model state')
      const restored = await restoreMemoryControlHandle({
        state,
        credential: { ...handle.credential },
        // The model ledger is restored from bytes, with no separately supplied token list.
      })
      expect(await assertProjection(restored)).toEqual(facts)
      expect(memoryModel(restored)).not.toBe(mls)
      const incomplete = JSON.parse(
        new TextDecoder().decode(memoryModel(restored).serializeState()),
      )
      incomplete.ledger = []
      incomplete.bodies = []
      memoryModel(restored).restoreState(new TextEncoder().encode(JSON.stringify(incomplete)))
      expect(restored.ledgerTokens).toEqual([])
      expect(await restored.isLedgerComplete()).toBe(false)
      expect(await memoryModel(restored).isLedgerComplete()).toBe(false)
      expect(readLedgerHead(restored)?.head).toEqual(readLedgerHead(handle)?.head)
      await expect(restored.bootstrapLedger(tokens.slice(1))).rejects.toThrow()
      await expect(
        restored.bootstrapLedger(tokens, {
          persist: () => {
            throw new Error('bootstrap persistence refused')
          },
        }),
      ).rejects.toThrow('bootstrap persistence refused')
      expect(restored.ledgerTokens).toEqual([])
      expect(await restored.isLedgerComplete()).toBe(false)
      await restored.bootstrapLedger(tokens)
      expect(await assertProjection(restored)).toEqual(facts)
    },
  )

  test('double reconstruction refuses a signed body substituted under an enacted ID', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup(identity, 'restored-ledger-body')
    const handle = await restoreMemoryControlHandle({
      state: seedMemoryControlState(group.state, group.credential),
      credential: group.credential,
    })
    const signed = (subject: string) => {
      return signLedgerEntry(identity, {
        type: 'kumiai.role',
        groupID: handle.groupID,
        subject,
        value: 'admin',
      })
    }
    const original = await signed(randomIdentity().id)
    const substituted = await signed(randomIdentity().id)
    const mls = memoryModel(handle)
    await mls.adopt(mls.buildCommit([original]))
    const state = structuredClone(handle.state)
    const durable = JSON.parse(new TextDecoder().decode(state.confirmationTag)) as {
      ledger: Array<string>
      bodies: Array<[string, string]>
    }
    expect(durable.ledger).toEqual([ledgerEntryDigest(original)])
    durable.bodies = [[durable.ledger[0] as string, substituted]]
    state.confirmationTag = new TextEncoder().encode(JSON.stringify(durable))

    const real = await restoreGroup({
      state,
      credential: handle.credential,
      ledgerEntries: [substituted],
    })
    expect(real.ledger.map(({ entryID }) => entryID)).toEqual([ledgerEntryDigest(substituted)])
    expect(await real.isLedgerComplete()).toBe(false)
    await expect(real.bootstrapLedger([substituted])).rejects.toThrow()
    await expect(
      restoreMemoryControlHandle({ state, credential: handle.credential }),
    ).rejects.toThrow('Memory ledger body ID mismatch')
  })

  test.each(['all', 'some'])(
    'double reconstruction preserves an incomplete ledger with %s bodies missing',
    async (missing) => {
      const { handle, identity, token } = await setup()
      const enacted = await signLedgerEntry(identity, {
        type: 'kumiai.role',
        groupID: handle.groupID,
        subject: randomIdentity().id,
        value: 'admin',
      })
      const mls = memoryModel(handle)
      await mls.adopt(mls.buildCommit([enacted]))
      const state = structuredClone(handle.state)
      const durable = JSON.parse(new TextDecoder().decode(state.confirmationTag)) as {
        bodies: Array<[string, string]>
      }
      durable.bodies = missing === 'all' ? [] : [[ledgerEntryDigest(token), token]]
      state.confirmationTag = new TextEncoder().encode(JSON.stringify(durable))
      const restored = await restoreMemoryControlHandle({ state, credential: handle.credential })
      const held = missing === 'all' ? [] : [token, token]
      expect(restored.ledgerTokens).toEqual(held)
      expect(await memoryModel(restored).getLedger()).toEqual(held)
      expect(await restored.isLedgerComplete()).toBe(false)
      expect(readLedgerHead(restored)?.head).toEqual(readLedgerHead(handle)?.head)
      const real = await restoreGroup({
        state,
        credential: handle.credential,
        ledgerEntries: held,
      })
      expect(await real.isLedgerComplete()).toBe(false)
      await expect(restored.bootstrapLedger(held)).rejects.toThrow()
      await restored.bootstrapLedger([token, token, enacted])
      expect(await restored.isLedgerComplete()).toBe(true)
      expect(await memoryModel(restored).isLedgerComplete()).toBe(true)
      expect(restored.ledgerTokens).toEqual([token, token, enacted])
    },
  )

  test('double refuses invalid enactments without changing control facts', async () => {
    const { handle, identity } = await setup()
    const outsider = randomIdentity()
    const claim = {
      type: 'kumiai.role',
      groupID: handle.groupID,
      subject: outsider.id,
      value: 'admin',
    }
    const invalid = [
      'invalid-token',
      await signLedgerEntry(identity, { ...claim, groupID: 'other-group' }),
      await signLedgerEntry(outsider, claim),
      await signLedgerEntry(identity, { ...claim, type: 'kumiai.unknown' }),
      await signLedgerEntry(identity, { ...claim, subject: identity.id, value: 'member' }),
      await signLedgerEntry(identity, {
        ...claim,
        type: 'kumiai.device',
        subject: identity.id,
        value: { op: 'register', controller: outsider.id },
      }),
    ]
    const mls = memoryModel(handle)
    const facts = recoveryTrustFor(handle, { groupID: handle.groupID, incarnation: 1 }, null)
    for (const token of invalid) {
      await expect(
        Promise.resolve().then(() => mls.adopt(mls.buildCommit([token]))),
      ).rejects.toThrow()
      expect(recoveryTrustFor(handle, { groupID: handle.groupID, incarnation: 1 }, null)).toEqual(
        facts,
      )
      expect(await mls.getLedger()).toEqual(handle.ledgerTokens)
    }
    const commit = JSON.parse(new TextDecoder().decode(mls.buildCommit([])))
    commit.head = 'forged-head'
    await expect(
      Promise.resolve().then(() => mls.adopt(new TextEncoder().encode(JSON.stringify(commit)))),
    ).rejects.toThrow()
    expect(await handle.isLedgerComplete()).toBe(true)
    expect(recoveryTrustFor(handle, { groupID: handle.groupID, incarnation: 1 }, null)).toEqual(
      facts,
    )
    await expect(
      restoreMemoryControlHandle({
        state: handle.state,
        credential: handle.credential,
        ledgerEntries: [],
      }),
    ).rejects.toThrow('projection mismatch')
    const state = structuredClone(handle.state)
    const extension = state.groupContext.extensions.find(
      (held) => held.extensionType === readLedgerHeadExtension(handle)?.extensionType,
    )
    if (!(extension?.extensionData instanceof Uint8Array)) throw new Error('Missing ledger head')
    extension.extensionData[1] = (extension.extensionData[1] as number) ^ 1
    await expect(
      restoreMemoryControlHandle({
        state,
        credential: handle.credential,
        ledgerEntries: handle.ledgerTokens,
      }),
    ).rejects.toThrow('authenticated ledger head mismatch')
  })

  test('double constructs a valid anchored handle', async () => {
    const options: GroupOptions = {
      keyRetention: {
        retainKeysForGenerations: 1000,
        maximumForwardRatchetSteps: 1000,
        retainKeysForEpochs: 8,
      },
      commitPolicy: () => 'accept',
      resolveLedgerEntries: async () => [],
      onLedgerEntries: () => {},
    }
    const s = await setup(options)
    expect(s.handle).toBeInstanceOf(GroupHandle)
    expect(readGroupAnchorExtension(s.handle)?.extensionData).toBeInstanceOf(Uint8Array)
    expect(s.handle.listMembers().map((member) => member.id)).toEqual([s.identity.id])
    expect(s.handle.memberCount).toBe(1)
    expect(s.handle.findMemberLeafIndex(s.identity.id)).toBe(0)
    expect(s.handle.bindingOfDID(s.identity.id)?.leafKey).toEqual(s.identity.publicKey)
    expect(s.handle.sendAdmission()).toEqual({ epoch: 0, admissible: true })
    expect(() =>
      validateRegistryHandle({
        handle: s.handle,
        key: { groupID: s.handle.groupID, incarnation: 1 },
        trust: null,
        environment: { identity: s.identity, options },
        ownerDID: s.identity.id,
      }),
    ).not.toThrow()
  })

  test('double membership and binding follow independent adds and removes', async () => {
    const s = await setup()
    const invitee = randomIdentity()
    const built = await buildSealedMemoryOperation(
      {
        id: 'add',
        kind: 'invite',
        revokes: false,
        seq: 1,
        enqueuedAt: 0,
        deadline: 1000,
        stage: 'intent',
        body: encodeStoredValue({ target: invitee.id }),
      },
      s.handle,
    )
    const state = decodeClientState(built.journal)
    if (state === undefined) throw new Error('Missing added state')
    const added = await restoreMemoryControlHandle({
      state,
      credential: s.handle.credential,
      ledgerEntries: s.handle.ledgerTokens,
    })
    expect(added.listMembers().map((member) => member.id)).toEqual([s.identity.id, invitee.id])
    expect(added.bindingOfDID(invitee.id)?.leafKey).toEqual(invitee.publicKey)
    expect(added.memberCount).toBe(2)
    expect(added.findMemberLeafIndex(invitee.id)).toBe(1)
    const mls = memoryModel(added)
    await mls.adopt(mls.buildCommit([], { removes: [invitee.id] }))
    expect(added.listMembers().map((member) => member.id)).toEqual([s.identity.id])
    expect(added.bindingOfDID(invitee.id)).toBeUndefined()
    expect(added.epoch).toBe(2n)
    expect(added.sendAdmission()).toEqual({ epoch: 2, admissible: true })
    const bytes = encodeClientState(added.state)
    const decoded = decodeClientState(bytes)
    if (decoded === undefined) throw new Error('Missing removed state')
    const restored = await restoreMemoryControlHandle({
      state: decoded,
      credential: added.credential,
      ledgerEntries: added.ledgerTokens,
    })
    expect(restored.listMembers().map((member) => member.id)).toEqual([s.identity.id])
    expect(restored.bindingOfDID(invitee.id)).toBeUndefined()
  })

  test('double exporter binds context', async () => {
    const { handle } = await setup()
    const context = new TextEncoder().encode('request/position/digest')
    const secret = await handle.exportSecret('confirmation', context, 32)
    for (const value of [
      'wrong/position/digest',
      'request/wrong/digest',
      'request/position/wrong',
    ]) {
      expect(
        await handle.exportSecret('confirmation', new TextEncoder().encode(value), 32),
      ).not.toEqual(secret)
    }
    expect(await handle.exportSecret('other', context, 32)).not.toEqual(secret)
    expect(await handle.exportSecret('confirmation', context, 32)).toEqual(secret)
    for (const length of [0, 1, 31, 32, 65]) {
      expect(await handle.exportSecret('confirmation', context, length)).toHaveLength(length)
    }
    expect(await handle.exportSecret('confirmation', context, 65)).not.toEqual(
      new Uint8Array([...secret, ...secret, 0]),
    )
  })

  test('double exporter refuses lengths rejected by the real provider', async () => {
    const { handle } = await setup()
    for (const length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8161]) {
      expect(
        await handle.exportSecret('confirmation', new Uint8Array(), length).then(
          () => 'accepted',
          () => 'refused',
        ),
      ).toBe('refused')
    }
  })

  test('double carries retained progress and never resurrects evicted epochs', async () => {
    const options: GroupOptions = { keyRetention: { retainKeysForEpochs: 8 } }
    const s = await setup(options)
    const first = await candidate(s.handle, options)
    const next = await candidate(first, options)
    expect(next.state.historicalReceiverData.has(0n)).toBe(true)
    first.state.historicalReceiverData.delete(0n)
    await first.carryReceiveProgress(next)
    expect(next.state.historicalReceiverData.has(0n)).toBe(false)
    expect(next.state.historicalReceiverData.has(1n)).toBe(true)
  })

  test('double recovery starts fresh progress in live and durable state', async () => {
    const s = await setup()
    const requester = await candidate(s.handle)
    const responder = await candidate(requester)
    const mls = memoryModel(requester)
    expect(mls.receiveHistory()).toHaveLength(1)
    const { request, requestKey } = await mls.createRecoveryRequest('fresh-progress')
    const pending = await mls.applyRecovery(
      await memoryModel(responder).sealGroupInfo(request),
      'fresh-progress',
      requestKey,
    )
    if (pending == null || 'renewalRequired' in pending)
      throw new Error('Missing recovery candidate')
    await pending.onAccepted(() => ({ mutationID: 'fresh-progress-adoption', changes: {} }))
    expect(mls.receiveHistory()).toEqual([])
    expect(requester.state.historicalReceiverData.size).toBe(0)
  })

  test('double preserves bound credentials and registry through byte reconstruction', async () => {
    const { bindingFor } = (await import(
      new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
    )) as {
      bindingFor(identity: ReturnType<typeof randomIdentity>): Promise<ControllerBinding>
    }
    const identity = randomIdentity()
    const binding = await bindingFor(identity)
    const { group } = await createGroup(identity, 'bound-double', { controller: binding })
    const state = decodeClientState(
      encodeClientState(seedMemoryControlState(group.state, group.credential)),
    )
    if (state === undefined) throw new Error('Missing bound state')
    const restored = await restoreMemoryControlHandle({
      state,
      credential: group.credential,
      ledgerEntries: [],
    })
    expect(restored.bindingOfDID(identity.id)).toEqual({
      leafKey: identity.publicKey,
      controller: binding.id,
      prefix: binding.prefix,
      capability: binding.capability,
    })
    expect(restored.listMembers()[0]?.controller).toBe(binding.id)
    expect(restored.registry).toEqual(group.registry)
    await expect(
      buildSealedMemoryOperation(
        {
          id: 'floating-add',
          kind: 'invite',
          revokes: false,
          seq: 1,
          enqueuedAt: 0,
          deadline: 1000,
          stage: 'intent',
          body: encodeStoredValue({ target: randomIdentity().id }),
        },
        restored,
      ),
    ).rejects.toThrow()
  })

  test('double durable state restores independently', async () => {
    const s = await setup()
    const next = await candidate(s.handle)
    const bytes = encodeClientState(next.state)
    const decoded = decodeClientState(bytes)
    if (decoded === undefined) throw new Error('Missing durable state')
    const restored = await restoreMemoryControlHandle({
      state: decoded,
      credential: { ...next.credential },
      ledgerEntries: [s.token, s.token],
    })
    bytes.fill(0)
    expect(restored.ledgerTokens).toEqual([s.token, s.token])
    expect(restored.listMembers().map((member) => member.id)).toEqual([s.identity.id])
    expect(restored.epoch).toBe(1n)
    expect(restored.state.historicalReceiverData.has(0n)).toBe(true)
    expect(restored.state.keySchedule.epochAuthenticator).toEqual(memoryModel(next).authenticator())
    expect(await restored.exportSecret('confirmation', new Uint8Array([1]), 32)).toEqual(
      await next.exportSecret('confirmation', new Uint8Array([1]), 32),
    )
    expect(memoryModel(restored)).not.toBe(memoryModel(next))
  })

  test('double ordinary branches differ', async () => {
    const { handle } = await setup()
    const first = await candidate(handle)
    const second = await candidate(handle)
    expect(first.epoch).toBe(1n)
    expect(second.epoch).toBe(1n)
    expect(first.state.keySchedule.epochAuthenticator).not.toEqual(
      second.state.keySchedule.epochAuthenticator,
    )
    expect(await first.exportSecret('confirmation', new Uint8Array([1]), 32)).not.toEqual(
      await second.exportSecret('confirmation', new Uint8Array([1]), 32),
    )
    expect(handle.epoch).toBe(0n)
  })

  test('double carry preserves committed progress without aliasing', async () => {
    const { handle } = await setup()
    const next = await candidate(handle)
    const live = handle.state.secretTree.intermediateNodes[0]
    if (live === undefined) throw new Error('Missing live progress')
    live.fill(17)
    await handle.carryReceiveProgress(next)
    expect(next.state.historicalReceiverData.get(0n)?.secretTree.intermediateNodes[0]).toEqual(
      new Uint8Array(32).fill(17),
    )
    live.fill(23)
    expect(next.state.historicalReceiverData.get(0n)?.secretTree.intermediateNodes[0]).toEqual(
      new Uint8Array(32).fill(17),
    )
    const state = decodeClientState(encodeClientState(next.state))
    if (state === undefined) throw new Error('Missing carried durable state')
    const restored = await restoreMemoryControlHandle({
      state,
      credential: next.credential,
      ledgerEntries: next.ledgerTokens,
    })
    expect(restored.state.historicalReceiverData.get(0n)?.secretTree.intermediateNodes[0]).toEqual(
      new Uint8Array(32).fill(17),
    )
  })

  test('double refuses unrelated progress and invalid restoration', async () => {
    const s = await setup()
    await expect(s.handle.carryReceiveProgress(s.handle)).rejects.toThrow()
    const mismatched = await candidate(s.handle)
    const retained = mismatched.state.historicalReceiverData.get(0n)
    if (retained === undefined) throw new Error('Missing retained identity')
    retained.resumptionPsk.fill(0)
    await expect(s.handle.carryReceiveProgress(mismatched)).rejects.toThrow()
    const other = await setup()
    await expect(other.handle.carryReceiveProgress(await candidate(s.handle))).rejects.toThrow()
    await expect(
      restoreMemoryControlHandle({
        state: s.handle.state,
        credential: { ...s.handle.credential, id: other.identity.id },
        ledgerEntries: [],
      }),
    ).rejects.toThrow()
    await expect(
      restoreMemoryControlHandle({
        state: {
          ...s.handle.state,
          groupContext: { ...s.handle.state.groupContext, extensions: [] },
        },
        credential: s.handle.credential,
        ledgerEntries: [],
      }),
    ).rejects.toThrow()
    await expect(
      restoreMemoryControlHandle({
        state: s.handle.state,
        credential: s.handle.credential,
        ledgerEntries: ['invalid-ledger-token'],
      }),
    ).rejects.toThrow()
  })
})
