import { nobleCrypto } from '@kokuin/crypto'
import { randomIdentity } from '@kokuin/token'
import type * as SozaiAsync from '@sozai/async'
import { encode, mlsMessageEncoder } from 'ts-mls'
import { expect, test, vi } from 'vitest'

import { commitInvite, commitLedgerEntries, createInvite } from '../src/group-commit.js'
import { createGroup, restoreGroup } from '../src/group-create.js'
import { createKeyPackageBundle } from '../src/group-credential.js'
import { CommitRejectedError, deriveGroup } from '../src/group-handle.js'
import { renewLeaf } from '../src/group-lifecycle.js'
import { removeMember } from '../src/group-membership.js'
import { processWelcome } from '../src/group-welcome.js'
import { ledgerEntryDigest, signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import { MissingLedgerEntriesError } from '../src/policy.js'
import {
  inception,
  lowLevelExternal,
  pipelineGroup,
  rawAdd,
  rawCommit,
  timedBinding,
} from './fixtures/lifecycle-pipeline.js'

const timers = vi.hoisted(() =>
  vi.fn((callback: () => void) => {
    setTimeout(callback, 0)
  }),
)
vi.mock('@sozai/async', async (importOriginal) => {
  const original = await importOriginal<typeof SozaiAsync>()
  return {
    ...original,
    maybeYield: original.createYielder({ budgetMs: 0, schedule: timers }).maybeYield,
  }
})

async function fixture() {
  const { group, identity, tokens } = await pipelineGroup({ standard: true })
  const recipient = randomIdentity()
  const bundle = await createKeyPackageBundle({ identity: recipient })
  const { invite } = await createInvite({
    group,
    identity,
    recipientDID: recipient.id,
    permission: 'member',
  })
  const added = await commitInvite({ group, invite, keyPackage: bundle.publicPackage })
  const welcome = {
    identity: recipient,
    invite,
    welcome: added.welcomeMessage,
    keyPackageBundle: bundle,
  }
  const receiver = (await processWelcome(welcome)).group
  const token = await signLedgerEntry({
    identity,
    entry: { type: 'app.note', groupID: group.groupID, subject: identity.id, value: 'hello' },
  })
  tokens.set(ledgerEntryDigest(token), token)
  const committed = await commitLedgerEntries({ group: added.newGroup, tokens: [token] })
  return { ...committed, source: added.newGroup, receiver, token, welcome, group, invite, bundle }
}

for (const policy of [{ yield: false }, {}, { yield: true }]) {
  const name = `yield=${policy.yield}`
  const schedules = () => expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)

  test(`${name}: ledger apply and restore preserve verified entries`, async () => {
    const f = await fixture()
    const verified = await verifyLedgerEntry({ token: f.token })
    timers.mockClear()
    expect(await f.source.clone().applyLedgerEntries([f.token, 'invalid'], policy)).toEqual([
      verified,
    ])
    schedules()
    timers.mockClear()
    const restored = await restoreGroup({
      state: structuredClone(f.newGroup.state),
      credential: f.newGroup.credential,
      ledgerEntries: f.newGroup.ledgerTokens,
      ...policy,
    })
    expect(restored.ledgerTokens).toEqual(f.newGroup.ledgerTokens)
    expect(restored.roster).toEqual(f.newGroup.roster)
    schedules()
  })

  test(`${name}: bootstrap retains authenticated head checks`, async () => {
    const f = await fixture()
    const restored = await restoreGroup({
      state: structuredClone(f.newGroup.state),
      credential: f.newGroup.credential,
    })
    timers.mockClear()
    await restored.bootstrapLedger({ tokens: f.newGroup.ledgerTokens, ...policy })
    expect(restored.ledgerTokens).toEqual(f.newGroup.ledgerTokens)
    schedules()
    const before = restored.ledgerTokens
    await expect(restored.bootstrapLedger({ tokens: [f.token], ...policy })).rejects.toThrow()
    expect(restored.ledgerTokens).toEqual(before)
  })

  test(`${name}: commit preparation, rejection and missing bodies preserve state`, async () => {
    const f = await fixture()
    const receive = f.receiver.clone({ resolveLedgerEntries: async () => [f.token] })
    timers.mockClear()
    expect(await receive.processMessage({ message: f.commitMessage, ...policy })).toBeNull()
    expect(receive.state.groupContext).toEqual(f.newGroup.state.groupContext)
    expect(receive.roster).toEqual(f.newGroup.roster)
    expect(receive.ledgerTokens).toEqual(f.newGroup.ledgerTokens)
    schedules()
    for (const missing of [false, true]) {
      const rejected = f.receiver.clone({
        resolveLedgerEntries: async () => (missing ? ['invalid'] : [f.token]),
      })
      const before = structuredClone(rejected.state)
      timers.mockClear()
      await expect(
        rejected.processMessage({
          message: f.commitMessage,
          commitPolicy: () => 'reject',
          ...policy,
        }),
      ).rejects.toBeInstanceOf(missing ? MissingLedgerEntriesError : CommitRejectedError)
      expect(rejected.state).toEqual(before)
      expect(rejected.ledgerTokens).toEqual(f.receiver.ledgerTokens)
      schedules()
    }
  })

  test(`${name}: builders and welcome forward the per-call policy`, async () => {
    const f = await fixture()
    timers.mockClear()
    const authored = await commitLedgerEntries({
      group: f.source.clone(),
      tokens: [f.token],
      ...policy,
    })
    expect(authored.epoch).toBe(f.newGroup.epoch)
    expect(authored.newGroup.ledgerTokens).toEqual(f.newGroup.ledgerTokens)
    schedules()
    timers.mockClear()
    const added = await commitInvite({
      group: f.group.clone(),
      invite: structuredClone(f.invite),
      keyPackage: f.bundle.publicPackage,
      ...policy,
    })
    expect(added.newGroup.ledgerTokens).toEqual(f.source.ledgerTokens)
    schedules()
    timers.mockClear()
    const joined = await processWelcome({ ...f.welcome, ...policy })
    expect(joined.group.ledgerTokens).toEqual(f.source.ledgerTokens)
    schedules()
    const demotion = f.source.ledgerTokens[0]
    if (demotion == null) throw new Error('Missing role entry')
    timers.mockClear()
    const removed = await removeMember({
      group: f.source.clone(),
      leafIndex: f.receiver.state.privatePath.leafIndex,
      ledgerEntries: [demotion],
      ...policy,
    })
    expect(removed.newGroup.listMembers()).toHaveLength(1)
    schedules()
    await expect(
      commitLedgerEntries({ group: f.source.clone(), tokens: [], ...policy }),
    ).rejects.toThrow('no ledger entries to commit')
  })
}

for (const policy of [{ yield: false }, {}, { yield: true }]) {
  test(`cold ledger verification yield=${policy.yield} preserves signatures`, async () => {
    const { group, identity } = await pipelineGroup({ standard: true })
    const token = await signLedgerEntry({
      identity,
      entry: { type: 'app.note', groupID: group.groupID, subject: identity.id, value: 'cold' },
    })
    timers.mockClear()
    const applied = await group.applyLedgerEntries([token], policy)
    expect(applied).toMatchObject([{ issuer: identity.id, entry: { value: 'cold' } }])
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
  })
}

for (const policy of [{ yield: false }, {}, { yield: true }]) {
  test(`cold signing and lifecycle authentication yield=${policy.yield}`, async () => {
    const identity = randomIdentity()
    const now = Math.floor(Date.now() / 1000)
    const controller = await timedBinding({ identity, iat: now - 1, exp: now + 100 })
    timers.mockClear()
    const { group } = await createGroup({
      identity,
      groupID: 'cold-lifecycle',
      controller,
      controllerLog: { chain: [inception], events: [] },
      crypto: { ...nobleCrypto },
      ...policy,
    })
    expect(group.sendAdmission().admissible).toBe(true)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    timers.mockClear()
    const token = await signLedgerEntry({
      identity,
      entry: { type: 'app.note', groupID: group.groupID, subject: identity.id, value: 'cold' },
      ...policy,
    })
    expect(token).toBeTypeOf('string')
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    timers.mockClear()
    const restored = await restoreGroup({
      state: structuredClone(group.state),
      credential: group.credential,
      ledgerEntries: group.ledgerTokens,
      options: { crypto: { ...nobleCrypto } },
      ...policy,
    })
    expect(restored.sendAdmission()).toEqual(group.sendAdmission())
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    timers.mockClear()
    const renewedBinding = await timedBinding({ identity, iat: now, exp: now + 100 })
    timers.mockClear()
    const renewed = await renewLeaf({ group: restored, binding: renewedBinding, ...policy })
    expect(renewed.epoch).toBe(restored.epoch + 1n)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    timers.mockClear()
    const built = await commitLedgerEntries({ group: restored, tokens: [token], ...policy })
    expect(built.newGroup.ledgerTokens.at(-1)).toBe(token)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    const recipient = randomIdentity()
    const recipientBinding = await timedBinding({
      identity: recipient,
      iat: now - 1,
      exp: now + 100,
    })
    const added = await rawAdd(group, recipient, recipientBinding)
    if (added.result.welcome == null) throw new Error('Missing Welcome')
    timers.mockClear()
    const joined = await processWelcome({
      identity: recipient,
      invite: {
        groupID: group.groupID,
        inviterID: identity.id,
        recipientDID: recipient.id,
        ledgerEntries: group.ledgerTokens,
      },
      welcome: encode(mlsMessageEncoder, added.result.welcome),
      keyPackageBundle: { ...added.bundle, ownerDID: recipient.id },
      options: { crypto: { ...nobleCrypto } },
      ...policy,
    })
    expect(joined.group.listMembers()).toHaveLength(2)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    const incoming = await rawCommit({
      group: await deriveGroup(group, added.result.newState),
      tokens: [token],
    })
    const receiver = await restoreGroup({
      state: structuredClone(joined.group.state),
      credential: joined.credential,
      ledgerEntries: joined.group.ledgerTokens,
      options: { crypto: { ...nobleCrypto }, resolveLedgerEntries: async () => [token] },
    })
    timers.mockClear()
    await receiver.processMessage({
      message: encode(mlsMessageEncoder, incoming.commit),
      ...policy,
    })
    expect(receiver.ledgerTokens.at(-1)).toBe(token)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    const bootstrap = await restoreGroup({
      state: structuredClone(joined.group.state),
      credential: joined.credential,
      options: { crypto: { ...nobleCrypto } },
    })
    timers.mockClear()
    await bootstrap.bootstrapLedger({ tokens: group.ledgerTokens, ...policy })
    expect(bootstrap.registry).toEqual(joined.group.registry)
    expect(timers.mock.calls.length > 0).toBe(policy.yield !== false)
    const external = await lowLevelExternal({
      group: joined.group,
      identity: recipient,
      binding: recipientBinding,
    })
    const inspect = await restoreGroup({
      state: structuredClone(joined.group.state),
      credential: joined.credential,
      ledgerEntries: joined.group.ledgerTokens,
      options: { crypto: { ...nobleCrypto } },
    })
    timers.mockClear()
    expect(await inspect.readCommitHeader(external)).toMatchObject({
      external: true,
      committerDID: recipient.id,
    })
    expect(timers).not.toHaveBeenCalled()
  })
}
