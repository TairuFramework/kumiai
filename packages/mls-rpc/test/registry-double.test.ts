import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  CommitAuthoringRefusedError,
  type ControllerBinding,
  commitKeyRotation,
  computeHead,
  createGroup,
  decodeClientState,
  encodeClientState,
  GroupHandle,
  type GroupOptions,
  ledgerEntryDigest,
  parseMLSCredentialIdentity,
  readGroupAnchorExtension,
  readLedgerHead,
  readLedgerHeadExtension,
  readMessageAAD,
  readMessageEpoch,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  contentTypes,
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  type PrivateMessage,
  wireformats,
} from 'ts-mls'
import { describe, expect, test, vi } from 'vitest'

import { encodeStoredValue } from '../src/persistence-codec.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { registryOptions, validateRegistryHandle } from '../src/registry/validation.js'
import { createRealGroup } from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import {
  buildSealedMemoryOperation,
  memoryModel,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
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
    await restoreMemoryControlSource({
      state: handle.state,
      credential: handle.credential,
      ledgerEntries: handle.ledgerTokens,
      options,
    }),
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
      await restoreMemoryControlSource({
        state: s.handle.state,
        credential: s.handle.credential,
        ledgerEntries: s.handle.ledgerTokens,
        options: s.options,
      }),
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
        await restoreMemoryControlSource({
          state: restored.state,
          credential: restored.credential,
          ledgerEntries: restored.ledgerTokens,
        }),
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
    const live = handle.state.secretTree.leafNodes[0]?.application.secret
    if (live === undefined) throw new Error('Missing live progress')
    live.fill(17)
    await handle.carryReceiveProgress(next)
    expect(
      next.state.historicalReceiverData.get(0n)?.secretTree.leafNodes[0]?.application.secret,
    ).toEqual(new Uint8Array(32).fill(17))
    live.fill(23)
    expect(
      next.state.historicalReceiverData.get(0n)?.secretTree.leafNodes[0]?.application.secret,
    ).toEqual(new Uint8Array(32).fill(17))
    const state = decodeClientState(encodeClientState(next.state))
    if (state === undefined) throw new Error('Missing carried durable state')
    const restored = await restoreMemoryControlHandle({
      state,
      credential: next.credential,
      ledgerEntries: next.ledgerTokens,
    })
    expect(
      restored.state.historicalReceiverData.get(0n)?.secretTree.leafNodes[0]?.application.secret,
    ).toEqual(new Uint8Array(32).fill(17))
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

const appOptions: GroupOptions = {
  keyRetention: {
    maximumForwardRatchetSteps: 3,
    retainKeysForGenerations: 2,
    retainKeysForEpochs: 2,
  },
}

async function appGroup(
  mode: 'real-mls' | 'double' = 'double',
  options: GroupOptions = appOptions,
) {
  const group = await createRealGroup(1, 'framed-app')
  const member = group.members[0]
  if (member === undefined) throw new Error('Missing member')
  const convert = (handle: GroupHandle) => {
    return (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
      state:
        mode === 'double'
          ? seedMemoryControlState(
              { ...handle.state, historicalReceiverData: new Map() },
              handle.credential,
              handle.ledgerTokens,
            )
          : structuredClone(handle.state),
      credential: handle.credential,
      ledgerEntries: handle.ledgerTokens,
      options,
    })
  }
  let sender = await convert(group.committer.handle)
  let local = await convert(member.handle)
  expect(local.state.privatePath.leafIndex).toBe(1)
  expect(local.memberCount).toBe(2)
  return {
    identity: member.identity,
    get local() {
      return local
    },
    get sender() {
      return sender
    },
    async advance(author: 'sender' | 'local' = 'sender') {
      const committer = author === 'sender' ? sender : local
      const receiver = author === 'sender' ? local : sender
      if (mode === 'double') {
        const commit = memoryModel(committer).buildCommit()
        await memoryModel(committer).adopt(commit)
        expect(
          (
            await memoryModel(receiver).processCommit(commit, {
              senderDID: committer.credential.id,
              resolveLedgerEntries: async () => [],
            })
          ).applied,
        ).toBe(true)
      } else {
        const rotated = await commitKeyRotation(committer)
        if (author === 'sender') sender = rotated.newGroup
        else local = rotated.newGroup
        await receiver.processMessage(rotated.commitMessage)
      }
    },
  }
}

function privateFrame(bytes: Uint8Array): PrivateMessage {
  const decoded = decode(mlsMessageDecoder, bytes.slice())
  if (decoded?.wireformat !== wireformats.mls_private_message)
    throw new Error('Missing private frame')
  return decoded.privateMessage
}

function rewriteFrame(bytes: Uint8Array, change: (frame: PrivateMessage) => void): Uint8Array {
  const decoded = decode(mlsMessageDecoder, bytes.slice())
  if (decoded?.wireformat !== wireformats.mls_private_message)
    throw new Error('Missing private frame')
  change(decoded.privateMessage)
  return encode(mlsMessageEncoder, decoded)
}

function flip(bytes: Uint8Array, index = 0): void {
  bytes[index] = (bytes[index] ?? 0) ^ 1
}

async function appFrames(sender: GroupHandle, count: number) {
  const frames: Array<Uint8Array> = []
  for (let index = 0; index < count; index++)
    frames.push(await sender.encrypt(new Uint8Array([index])))
  return frames
}

describe('double application frames', () => {
  test('double private commit authoring advances only the own handshake ratchet', async () => {
    const { local: handle } = await appGroup()
    const source = await restoreMemoryControlSource({
      state: handle.state,
      credential: handle.credential,
      ledgerEntries: handle.ledgerTokens,
      options: appOptions,
    })
    const index = source.state.privatePath.leafIndex * 2
    const before = source.state.secretTree.leafNodes[index]?.handshake.generation ?? 0
    const built = await buildSealedMemoryOperation(
      {
        id: 'handshake',
        kind: 'invite',
        revokes: false,
        seq: 1,
        enqueuedAt: 0,
        deadline: 1000,
        stage: 'intent',
        body: encodeStoredValue({ target: source.credential.id }),
      },
      source,
    )
    expect(source.state.secretTree.leafNodes[index]?.handshake.generation).toBe(before + 1)
    expect(source.state.secretTree.leafNodes[index]?.application.generation).toBe(0)
    const state = decodeClientState(built.journal)
    expect(
      state?.historicalReceiverData.get(handle.epoch)?.secretTree.leafNodes[index]?.handshake
        .generation,
    ).toBe(before + 1)
    expect(handle.state.secretTree.leafNodes[index]?.handshake.generation ?? 0).toBe(before)
  })

  test('double frames parse as MLS private messages', async () => {
    const { local, sender } = await appGroup()
    const aad = new Uint8Array([8, 9])
    const frame = await sender.encrypt(new Uint8Array([42]), { aad })
    expect(readMessageEpoch(frame)).toBe(local.epoch)
    expect(readMessageAAD(frame)).toEqual(aad)
    expect(privateFrame(frame).groupId).toEqual(local.state.groupContext.groupId)
    expect(privateFrame(frame).contentType).toBe(contentTypes.application)
    expect(privateFrame(frame).ciphertext).toHaveLength(33)
  })

  test('double opens a member frame once', async () => {
    const { local, sender } = await appGroup()
    const frame = await sender.encrypt(new Uint8Array([42]))
    expect(await local.decrypt(frame)).toEqual({
      payload: new Uint8Array([42]),
      senderDID: sender.credential.id,
      aad: new Uint8Array(),
    })
    await expect(local.decrypt(frame)).rejects.toThrow('Desired gen in the past')
    await expect(commitKeyRotation(local)).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
  })

  test('double compares AAD before consuming', async () => {
    const { local, sender } = await appGroup()
    const frame = await sender.encrypt(new Uint8Array([42]), { aad: new Uint8Array([7]) })
    const before = encodeClientState(local.state)
    await expect(local.decrypt(frame, { expectedAAD: new Uint8Array([8]) })).rejects.toThrow(
      'expected AAD',
    )
    await expect(
      local.decryptStaged(frame, { expectedAAD: new Uint8Array([8]) }, async () => {
        throw new Error('Persistence must not run')
      }),
    ).rejects.toThrow('expected AAD')
    expect(encodeClientState(local.state)).toEqual(before)
    expect((await local.decrypt(frame, { expectedAAD: new Uint8Array([7]) })).payload).toEqual(
      new Uint8Array([42]),
    )
  })

  test.each(['decrypt', 'decryptStaged'] as const)(
    'double %s tag binds epoch, sender and AAD',
    async (method) => {
      const { local, sender } = await appGroup()
      const open = (bytes: Uint8Array) =>
        method === 'decrypt' ? local.decrypt(bytes) : local.decryptStaged(bytes, {}, async () => {})
      const frame = await sender.encrypt(new Uint8Array([42]), { aad: new Uint8Array([7]) })
      await (async () => {
        const source = memoryModel(local)
        const commit = source.buildCommit()
        await source.adopt(commit)
        local.state
      })()
      const before = encodeClientState(local.state)
      const changes: Array<{
        change: (pm: PrivateMessage) => void
        error: string
      }> = [
        {
          change: (pm) => {
            pm.epoch = local.epoch
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            pm.epoch = local.epoch + 1n
          },
          error: 'Unavailable memory epoch',
        },
        {
          change: (pm) => {
            flip(pm.groupId)
          },
          error: 'Memory group mismatch',
        },
        {
          change: (pm) => {
            flip(pm.encryptedSenderData, 3)
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            flip(pm.encryptedSenderData, 7)
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            flip(pm.authenticatedData)
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            flip(pm.ciphertext)
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            flip(pm.ciphertext, pm.ciphertext.length - 1)
          },
          error: 'Invalid memory application tag',
        },
        {
          change: (pm) => {
            pm.ciphertext = pm.ciphertext.slice(0, -1)
          },
          error: 'Invalid memory application tag',
        },
      ]
      for (const { change, error } of changes) {
        await expect(open(rewriteFrame(frame, change))).rejects.toThrow(error)
        expect(encodeClientState(local.state)).toEqual(before)
      }
      await expect(open(frame.slice(0, -1))).rejects.toThrow('Data length exceeds buffer')
      expect(encodeClientState(local.state)).toEqual(before)
      expect((await open(frame)).payload).toEqual(new Uint8Array([42]))
    },
  )

  test('double staged failure keeps the key', async () => {
    const { local, sender } = await appGroup()
    const frame = await sender.encrypt(new Uint8Array([42]))
    const before = encodeClientState(local.state)
    await expect(
      local.decryptStaged(frame, {}, async () => {
        throw new Error('Disk refused')
      }),
    ).rejects.toThrow('Disk refused')
    expect(encodeClientState(local.state)).toEqual(before)
    let saved: Uint8Array | undefined
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const opening = local.decryptStaged(frame, {}, async (bytes) => {
      saved = bytes
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    expect(encodeClientState(local.state)).toEqual(before)
    gate.resolve()
    expect((await opening).payload).toEqual(new Uint8Array([42]))
    expect(encodeClientState(local.state)).toEqual(saved)
    await expect(local.decrypt(frame)).rejects.toThrow('Desired gen in the past')
  })

  test('double unnamed sender refuses', async () => {
    const { local, sender } = await appGroup()
    const frame = await sender.encrypt(new Uint8Array([42]))
    const index = sender.state.privatePath.leafIndex * 2
    const leaf = local.state.ratchetTree[index]
    local.state.ratchetTree[index] = undefined
    await expect(local.decrypt(frame)).rejects.toThrow('Unnamed memory sender')
    await expect(local.decryptStaged(frame, {}, async () => {})).rejects.toThrow(
      'Unnamed memory sender',
    )
    local.state.ratchetTree[index] = leaf
    expect((await local.decrypt(frame)).senderDID).toBe(sender.credential.id)
  })

  test('double progress survives encode and restore', async () => {
    const { local, sender } = await appGroup()
    const frames = await appFrames(sender, 4)
    await local.decrypt(frames[3] as Uint8Array)
    const state = decodeClientState(encodeClientState(local.state))
    if (state === undefined) throw new Error('Missing state')
    const durable = JSON.parse(new TextDecoder().decode(state.confirmationTag))
    expect(durable.receiveState).toBeUndefined()
    expect(durable.receiveHistory).toBeUndefined()
    const restored = await restoreMemoryControlHandle({
      state,
      credential: local.credential,
      ledgerEntries: local.ledgerTokens,
      options: appOptions,
    })
    await expect(restored.decrypt(frames[3] as Uint8Array)).rejects.toThrow(
      'Desired gen in the past',
    )
    await expect(restored.decrypt(frames[0] as Uint8Array)).rejects.toThrow(
      'Desired gen in the past',
    )
    expect((await restored.decrypt(frames[1] as Uint8Array)).payload).toEqual(new Uint8Array([1]))
    expect((await restored.decrypt(frames[2] as Uint8Array)).payload).toEqual(new Uint8Array([2]))
    const own = await restored.encrypt(new Uint8Array([9]))
    expect((await sender.decrypt(own)).payload).toEqual(new Uint8Array([9]))
  })

  test('double opens across an epoch transition', async () => {
    const f = await appGroup()
    await f.advance()
    const own = await f.local.encrypt(new Uint8Array([9]))
    expect((await f.sender.decrypt(own)).payload).toEqual(new Uint8Array([9]))
    expect((await f.local.decrypt(await f.sender.encrypt(new Uint8Array([42])))).payload).toEqual(
      new Uint8Array([42]),
    )
  })

  for (const method of ['decrypt', 'decryptStaged'] as const) {
    for (const epoch of ['current', 'retained'] as const) {
      test.each(['registry advance', 'control authoring', 'registry adoption'] as const)(
        `${method} keeps consumed ${epoch} generations across %s`,
        async (path) => {
          const options = registryOptions({ keyRetention: { retainKeysForEpochs: 2 } })
          const f = await appGroup('double', options)
          const fixture = await createRegistryFixture({
            mode: 'double',
            setup: 'empty',
            groupID: f.local.groupID,
            identity: f.identity,
            options,
          })
          const open = (handle: GroupHandle, bytes: Uint8Array) =>
            method === 'decrypt'
              ? handle.decrypt(bytes)
              : handle.decryptStaged(bytes, {}, async () => {})
          const frame = await f.sender.encrypt(new Uint8Array([42]))
          if (epoch === 'retained') await f.advance()
          const sourceEpoch = f.local.epoch
          const consume = async (handle: GroupHandle) => {
            const own = await handle.encrypt(new Uint8Array([9]))
            expect((await open(f.sender, own)).payload).toEqual(new Uint8Array([9]))
            expect((await open(handle, frame)).payload).toEqual(new Uint8Array([42]))
            return own
          }
          try {
            let advanced: GroupHandle
            let own: Uint8Array
            if (path === 'registry adoption') {
              await fixture.registry.seed(f.local, {
                packageUse: { sourceID: 'retained', ref: 'member', kind: 'ordinary' },
              })
              const access = await fixture.registry.access(f.local.groupID)
              // Build first so adoption must carry progress committed afterwards.
              const { candidate, write } = await fixture.acceptedOrdinary(access)
              own = await access.mutate(async (handle, persist) => {
                const bytes = await consume(handle)
                await persist(handle)
                return bytes
              })
              const expected = await access.readControl(async ({ source }) => source)
              write.expected = { ...write.expected, ...expected }
              expect(await access.adopt(candidate, expected, write)).toBe('installed')
              advanced = await access.read((handle) => handle)
            } else if (path === 'control authoring') {
              own = await consume(f.local)
              const source = await restoreMemoryControlSource({
                state: f.local.state,
                credential: f.local.credential,
                ledgerEntries: f.local.ledgerTokens,
                options,
              })
              const built = await buildSealedMemoryOperation(
                {
                  id: 'retained',
                  kind: 'invite',
                  revokes: false,
                  seq: 1,
                  enqueuedAt: 0,
                  deadline: 1000,
                  stage: 'intent',
                  body: encodeStoredValue({ target: source.credential.id }),
                },
                source,
              )
              const state = decodeClientState(built.journal)
              if (state === undefined) throw new Error('Missing control candidate')
              advanced = await restoreMemoryControlHandle({
                state,
                credential: source.credential,
                ledgerEntries: source.ledgerTokens,
                options,
              })
            } else {
              own = await consume(f.local)
              advanced = await fixture.advance(f.local)
            }
            // The peer also advances directly without a state read after its receive.
            const peer = memoryModel(f.sender)
            await peer.adopt(peer.buildCommit())
            expect(advanced.epoch).toBe(sourceEpoch + 1n)
            await expect(advanced.decrypt(frame)).rejects.toThrow('Desired gen in the past')
            await expect(f.sender.decrypt(own)).rejects.toThrow('Desired gen in the past')
            expect(
              advanced.state.historicalReceiverData.get(sourceEpoch)?.secretTree.leafNodes[2]
                ?.application.generation,
            ).toBe(1)
          } finally {
            await fixture.close()
          }
        },
      )
    }
  }
})

for (const mode of ['real-mls', 'double'] as const) {
  describe(`application ratchet limits: ${mode}`, () => {
    test.each(['sender', 'local'] as const)(
      'own encrypt keeps consumed generations across direct %s commit adoption',
      async (author) => {
        const f = await appGroup(mode)
        const own = await f.local.encrypt(new Uint8Array([9]))
        expect((await f.sender.decrypt(own)).payload).toEqual(new Uint8Array([9]))
        await f.advance(author)
        await expect(f.sender.decrypt(own)).rejects.toThrow('Desired gen in the past')
        expect(
          f.local.state.historicalReceiverData.get(1n)?.secretTree.leafNodes[2]?.application
            .generation,
        ).toBe(1)
      },
    )

    for (const method of ['decrypt', 'decryptStaged'] as const) {
      test.each(['sender', 'local'] as const)(
        `${method} keeps consumed generations across direct %s commit adoption`,
        async (author) => {
          const f = await appGroup(mode)
          const own = await f.local.encrypt(new Uint8Array([9]))
          const frame = await f.sender.encrypt(new Uint8Array([42]))
          const retained = await f.sender.encrypt(new Uint8Array([43]))
          const open = (handle: GroupHandle, bytes: Uint8Array) =>
            method === 'decrypt'
              ? handle.decrypt(bytes)
              : handle.decryptStaged(bytes, {}, async () => {})
          expect((await open(f.sender, own)).payload).toEqual(new Uint8Array([9]))
          expect((await open(f.local, frame)).payload).toEqual(new Uint8Array([42]))
          // No state getter may refresh the receive snapshot before advancing.
          await f.advance(author)
          await expect(f.local.decrypt(frame)).rejects.toThrow('Desired gen in the past')
          await expect(f.sender.decrypt(own)).rejects.toThrow('Desired gen in the past')
          expect(
            (await f.sender.decrypt(await f.local.encrypt(new Uint8Array([10])))).payload,
          ).toEqual(new Uint8Array([10]))
          expect((await open(f.local, retained)).payload).toEqual(new Uint8Array([43]))
          await f.advance(author)
          await expect(f.local.decrypt(retained)).rejects.toThrow('Desired gen in the past')
        },
      )
    }

    test('generation beyond the forward limit refuses', async () => {
      const { local, sender } = await appGroup(mode)
      const frames = await appFrames(sender, 5)
      const before = encodeClientState(local.state)
      await expect(local.decrypt(frames[4] as Uint8Array)).rejects.toThrow(
        'Desired generation too far in the future',
      )
      expect(encodeClientState(local.state)).toEqual(before)
      expect((await local.decrypt(frames[3] as Uint8Array)).payload).toEqual(new Uint8Array([3]))
    })

    test('evicted skipped generation refuses', async () => {
      const { local, sender } = await appGroup(mode)
      const frames = await appFrames(sender, 4)
      await local.decrypt(frames[3] as Uint8Array)
      await expect(local.decrypt(frames[0] as Uint8Array)).rejects.toThrow(
        'Desired gen in the past',
      )
      expect((await local.decrypt(frames[1] as Uint8Array)).payload).toEqual(new Uint8Array([1]))
      await expect(local.decrypt(frames[1] as Uint8Array)).rejects.toThrow(
        'Desired gen in the past',
      )
    })

    test('retained past epoch opens; an evicted epoch refuses', async () => {
      const f = await appGroup(mode)
      const frames = await appFrames(f.sender, 2)
      await f.advance()
      await f.advance()
      expect((await f.local.decrypt(frames[0] as Uint8Array)).payload).toEqual(new Uint8Array([0]))
      await expect(f.local.decrypt(frames[0] as Uint8Array)).rejects.toThrow(
        'Desired gen in the past',
      )
      await f.advance()
      expect(f.local.state.historicalReceiverData.size).toBe(2)
      await expect(f.local.decrypt(frames[1] as Uint8Array)).rejects.toThrow()
    })

    test('lapsed sender refuses', async () => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
      try {
        const fixture = (await import(
          new URL('../../mls/test/fixtures/lifecycle-pipeline.ts', import.meta.url).href
        )) as {
          pipelineGroup(): Promise<{ group: GroupHandle; identity: OwnIdentity }>
          lowLevelWelcome(
            group: GroupHandle,
            identity: OwnIdentity,
            binding: ControllerBinding,
          ): Promise<{ author: GroupHandle; joined: GroupHandle }>
          timedBinding(params: {
            identity: OwnIdentity
            iat: number
            exp: number
          }): Promise<ControllerBinding>
        }
        const { group } = await fixture.pipelineGroup()
        const bob = randomIdentity()
        const pair = await fixture.lowLevelWelcome(
          group,
          bob,
          await fixture.timedBinding({ identity: bob, iat: 90, exp: 110 }),
        )
        const convert = (handle: GroupHandle) =>
          mode === 'real-mls'
            ? Promise.resolve(handle)
            : restoreMemoryControlHandle({
                state: seedMemoryControlState(
                  { ...handle.state, historicalReceiverData: new Map() },
                  handle.credential,
                  handle.ledgerTokens,
                ),
                credential: handle.credential,
                ledgerEntries: handle.ledgerTokens,
              })
        const local = await convert(pair.joined)
        const sender = await convert(pair.author)
        expect(local.state.privatePath.leafIndex).toBe(1)
        const frame = await sender.encrypt(new Uint8Array([42]))
        const clockLeaf = local.state.ratchetTree[2]
        if (clockLeaf?.nodeType !== 1 || !('identity' in clockLeaf.leaf.credential))
          throw new Error('Missing clock leaf')
        const original = clockLeaf.leaf.credential.identity
        clockLeaf.leaf.credential.identity = new TextEncoder().encode(
          JSON.stringify({
            ...parseMLSCredentialIdentity(original),
            controller: await fixture.timedBinding({ identity: bob, iat: 210, exp: 300 }),
          }),
        )
        const before = encodeClientState(local.state)
        await expect(local.decrypt(frame)).rejects.toMatchObject({ reason: 'lapsed' })
        await expect(
          local.decryptStaged(frame, {}, async () => {
            throw new Error('Persistence must not run')
          }),
        ).rejects.toMatchObject({ reason: 'lapsed' })
        expect(encodeClientState(local.state)).toEqual(before)
        clockLeaf.leaf.credential.identity = original
        expect((await local.decrypt(frame)).payload).toEqual(new Uint8Array([42]))
      } finally {
        clock.mockRestore()
      }
    })
  })
}
