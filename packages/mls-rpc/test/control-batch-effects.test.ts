import { commitLedgerEntries, signLedgerEntry } from '@kumiai/mls'
import {
  asLogPosition,
  controlBatch,
  createLedgerEntryResolver,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { prepareControlOccurrence } from '../../rpc/lib/control-prepare.js'
import { createGroupCrypto } from '../src/crypto.js'
import { entryCapability } from '../src/entry-capability.js'
import { createRegistryGroupMLS } from '../src/registry-group-mls.js'
import { testHandleAccess } from './fixtures/real-group.js'
import { createRegistryCryptoGroup } from './fixtures/registry-crypto.js'
import { memoryModel } from './fixtures/sealed-memory-mls.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`buffered control opens new ledger bodies with a custom entry label (${mode})`, async () => {
    const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
    })
    try {
      const f = group.fixture()
      const author = group.group.committer
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const token = await signLedgerEntry(author.identity, {
        type: 'note',
        groupID: group.key.groupID,
        subject: author.identity.id,
        value: 'custom label',
      })
      const commit =
        mode === 'double'
          ? memoryModel(author.handle).buildCommit([token])
          : (await commitLedgerEntries(author.handle, [token])).commitMessage
      const entryLabel = 'custom-control-entries'
      const sender = createGroupCrypto({
        access: testHandleAccess({ handle: () => author.handle, adopt: async () => {} }),
        entryLabel,
      })
      const receiver = createGroupCrypto({ access: group.access(), entryLabel })
      const entries = encodeLedgerEntries([token])
      const { sealed } = await sender.sealEntries(entries)
      await expect(receiver.openEntries(sealed)).resolves.toEqual(entries)
      const mls = await createRegistryGroupMLS({
        registry: f.registry,
        key: group.key,
        recovery: f.environment,
        identity: f.identity,
        entrySlot: local.slot,
        target: { targetID: 'hub', topicID: 'commits' },
      })
      const binding = controlBatch(mls)
      if (binding === undefined) throw new Error('Missing control batch')
      await expect(
        binding.run({
          source: 'custom-entry-label',
          prepare: (scope) =>
            scope.prepareCommit(commit, {
              resolveLedgerEntries: createLedgerEntryResolver(sealed, scope.openEntries),
              adoption: (staged) => ({
                mutationID: crypto.randomUUID(),
                changes: { cursor: { position: asLogPosition('01'), epoch: staged.epochAfter } },
              }),
            }),
        }),
      ).resolves.toMatchObject({ value: { applied: true } })
      expect(await f.device.groups.loadState(group.key)).toMatchObject({
        epoch: group.access().epoch(),
        ledger: expect.arrayContaining([token]),
      })
    } finally {
      await group.close()
    }
  })

  test.each(['commit', 'entries-outer', 'entries-inner'] as const)(
    `selected unsupported %s version preserves the upgrade diagnostic (${mode})`,
    async (kind) => {
      const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
        backgroundMaintenance: 'gated',
      })
      try {
        const f = group.fixture()
        const author = group.group.committer
        const local = group.group.members[0]
        if (local === undefined) throw new Error('Missing local member')
        const token = await signLedgerEntry(author.identity, {
          type: 'note',
          groupID: group.key.groupID,
          subject: author.identity.id,
          value: 'versioned',
        })
        const commit =
          mode === 'double'
            ? memoryModel(author.handle).buildCommit([token])
            : (await commitLedgerEntries(author.handle, [token])).commitMessage
        const cryptoPort = createGroupCrypto({
          access: testHandleAccess({
            handle: () => author.handle,
            adopt: async () => {},
          }),
        })
        const entries = encodeLedgerEntries([token])
        if (kind === 'entries-inner') entries[0] = 255
        const { sealed } = await cryptoPort.sealEntries(entries)
        if (kind === 'entries-outer') sealed[0] = 255
        const inner = encodeCommitFrame(commit, sealed)
        if (kind === 'commit') inner[0] = 255
        const payload = encodeHandshakeFrame(HANDSHAKE_KIND.commit, inner)
        const mls = await createRegistryGroupMLS({
          registry: f.registry,
          key: group.key,
          recovery: f.environment,
          identity: f.identity,
          entrySlot: local.slot,
          target: { targetID: 'hub', topicID: 'commits' },
        })
        const binding = controlBatch(mls)
        if (binding === undefined) throw new Error('Missing control batch')
        const result = await binding.run({
          source: 'unsupported-version',
          prepare: (scope) =>
            prepareControlOccurrence({
              scope,
              page: {
                topicID: 'commits',
                after: null,
                generation: 0,
                result: {
                  messages: [
                    {
                      topicID: 'commits',
                      sequenceID: '01',
                      senderDID: author.identity.id,
                      payload,
                    },
                  ],
                  head: '01',
                  oldest: '01',
                  gap: false,
                },
              },
              index: 0,
              localDID: f.identity.id,
              ownCommitDigest: () => null,
              adoption: () => () => {
                throw new Error('Unsupported commit cannot adopt')
              },
              newID: () => crypto.randomUUID(),
            }),
        })
        expect(result.value).toMatchObject({
          consumed: true,
          diagnostic: { kind: 'unknown-version' },
        })
        expect(result.control.cursor?.position).toBe('01')
        expect(result.control.strand).toBeNull()
        expect(result.control.controlHold).toBeNull()
      } finally {
        await group.close()
      }
    },
  )

  test(`selected ledger notifications are discarded on preparation failure (${mode})`, async () => {
    const notices = vi.fn()
    const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
      options: { onLedgerEntries: notices },
    })
    try {
      const f = group.fixture()
      const author = group.group.committer
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const token = await signLedgerEntry(author.identity, {
        type: 'note',
        groupID: group.key.groupID,
        subject: author.identity.id,
        value: 'buffer me',
      })
      const commit =
        mode === 'double'
          ? memoryModel(author.handle).buildCommit([token])
          : (await commitLedgerEntries(author.handle, [token])).commitMessage
      const mls = await createRegistryGroupMLS({
        registry: f.registry,
        key: group.key,
        recovery: f.environment,
        identity: f.identity,
        entrySlot: local.slot,
        target: { targetID: 'hub', topicID: 'commits' },
      })
      const binding = controlBatch(mls)
      if (binding === undefined) throw new Error('Missing control binding')
      const before = await f.device.groups.loadState(group.key)
      const control = await f.device.groups.ports(group.key).control.load()
      notices.mockClear()
      await expect(
        binding.run({
          source: 'failed-notification',
          prepare: async (scope) => {
            expect(
              await scope.prepareCommit(commit, { resolveLedgerEntries: async () => [token] }),
            ).toMatchObject({ applied: true })
            throw new Error('after processCommit')
          },
        }),
      ).rejects.toThrow('after processCommit')
      expect(notices).not.toHaveBeenCalled()
      expect(await f.device.groups.loadState(group.key)).toEqual(before)
      expect(await f.device.groups.ports(group.key).control.load()).toEqual(control)
    } finally {
      await group.close()
    }
  })

  test(`selected ledger notifications wait for commit proof and fire once (${mode})`, async () => {
    const notices = vi.fn()
    const group = await createRegistryCryptoGroup(mode, crypto.randomUUID(), 2, {
      backgroundMaintenance: 'gated',
      options: { onLedgerEntries: notices },
    })
    let release: (() => void) | undefined
    try {
      const f = group.fixture()
      const author = group.group.committer
      const local = group.group.members[0]
      if (local === undefined) throw new Error('Missing local member')
      const token = await signLedgerEntry(author.identity, {
        type: 'note',
        groupID: group.key.groupID,
        subject: author.identity.id,
        value: 'prove me',
      })
      const commit =
        mode === 'double'
          ? memoryModel(author.handle).buildCommit([token])
          : (await commitLedgerEntries(author.handle, [token])).commitMessage
      const mls = await createRegistryGroupMLS({
        registry: f.registry,
        key: group.key,
        recovery: f.environment,
        identity: f.identity,
        entrySlot: local.slot,
        target: { targetID: 'hub', topicID: 'commits' },
      })
      const binding = controlBatch(mls)
      if (binding === undefined) throw new Error('Missing control binding')
      notices.mockClear()
      const capability = entryCapability(f.device.groups)
      if (capability === null) throw new Error('Missing capability')
      const run = capability.run.bind(capability)
      vi.spyOn(capability, 'run').mockImplementationOnce((request, ...args) =>
        run({ ...request, mutationID: 'notification-proof' }, ...args),
      )
      f.armWorkFault('notification-proof', 'commit-then-reject')
      const proof = f.holdProof('notification-proof')
      release = proof.release
      const applied = binding.run({
        source: 'proven-notification',
        prepare: async (scope) => {
          const result = await scope.prepareCommit(commit, {
            resolveLedgerEntries: async () => [token],
            adoption: (staged) => ({
              mutationID: 'notification-proof',
              changes: { cursor: { position: asLogPosition('01'), epoch: staged.epochAfter } },
            }),
          })
          expect(result.applied).toBe(true)
          return result
        },
      })
      await Promise.race([
        proof.started,
        applied.then(() => {
          throw new Error('Proof was not held')
        }),
      ])
      expect(notices).not.toHaveBeenCalled()
      release()
      release = undefined
      expect((await applied).value.applied).toBe(true)
      expect(notices).toHaveBeenCalledTimes(1)
      expect(notices.mock.calls[0]?.[0]).toMatchObject([
        { entry: { type: 'note', value: 'prove me' } },
      ])
    } finally {
      release?.()
      await group.close()
    }
  })
}
