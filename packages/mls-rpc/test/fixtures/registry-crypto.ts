import {
  commitKeyRotation,
  decodeClientState,
  encodeClientState,
  type GroupOptions,
  restoreGroup,
} from '@kumiai/mls'
import { frameID, isAppLogPosition } from '@kumiai/rpc'
import type { PendingCryptoFixture, RegistryCryptoFixture } from '@kumiai/rpc-conformance'
import { onTestFinished } from 'vitest'

import { createGroupCrypto } from '../../src/crypto.js'
import { createGroupHandleRegistry } from '../../src/registry/registry.js'
import { createRealGroup, testHandleAccess } from './real-group.js'
import { createRegistryFixture } from './registry.js'
import { registryHandle } from './registry-welcome.js'
import { memoryModel, restoreMemoryControlHandle } from './sealed-memory-mls.js'
import { createStorageFixture } from './storage-persistence.js'

type Mode = 'real-mls' | 'double'

export async function createRegistryCryptoGroup(
  mode: Mode,
  id: string,
  size: number,
  config: { backgroundMaintenance?: 'gated'; options?: GroupOptions } = {},
) {
  const group = await createRealGroup(size, `registry-crypto-conformance-${mode}-${id}`)
  const local = group.members[0]
  if (local === undefined) throw new Error('Missing registry crypto member')
  let fixture = await createRegistryFixture({
    mode,
    backgroundMaintenance: config.backgroundMaintenance,
    setup: 'empty',
    groupID: local.handle.groupID,
    identity: local.identity,
    options: { ...config.options, resolveLedgerEntries: local.slot.resolve },
  })
  for (const member of [group.committer, ...group.members]) {
    const options = { ...fixture.environment.options, resolveLedgerEntries: member.slot.resolve }
    member.handle =
      mode === 'double'
        ? await registryHandle({ mode, handle: member.handle, options })
        : await restoreGroup({
            state: structuredClone(member.handle.state),
            credential: member.handle.credential,
            ledgerEntries: member.handle.ledgerTokens,
            options,
          })
  }
  const key = await fixture.registry.seed(local.handle, {
    packageUse: { sourceID: 'registry-crypto-conformance', ref: 'joined', kind: 'ordinary' },
  })
  let access = await fixture.registry.access(key.groupID)
  let outstanding: Uint8Array | undefined
  let hintOffset = 0
  const receiver = () =>
    createGroupCrypto({ access: { ...access, epoch: () => access.epoch() + hintOffset } })
  const sender = group.members[1] ?? group.committer
  const memberAccesses = group.members.map((member, index) =>
    index === 0
      ? undefined
      : testHandleAccess({
          handle: () => member.handle,
          adopt: (next) => {
            member.handle = next
          },
        }),
  )

  async function rotate(removed?: number) {
    let commit: Uint8Array
    if (mode === 'double') {
      const model = memoryModel(group.committer.handle)
      const member = removed === undefined ? undefined : group.members[removed]
      commit = model.buildCommit([], member === undefined ? {} : { removes: [member.identity.id] })
      await model.adopt(commit)
    } else if (removed === undefined) {
      const result = await commitKeyRotation(group.committer.handle)
      group.committer.handle = result.newGroup
      commit = result.commitMessage
    } else {
      const { buildRealCommit } = await import('./real-group.js')
      commit = await buildRealCommit(group, { removes: removed })
    }
    for (const [index, memberAccess] of memberAccesses.entries()) {
      if (memberAccess === undefined || index === removed) continue
      await memberAccess.mutate((handle, persist) => handle.processMessage(commit, { persist }))
    }
    return commit
  }

  return {
    group,
    key,
    sender,
    receiver,
    access: () => access,
    fixture: () => fixture,
    setEpochHintOffset: (offset: number) => {
      hintOffset = offset
    },
    members: group.members.map((member, index) => {
      const memberAccess = memberAccesses[index]
      return {
        did: member.identity.id,
        crypto:
          memberAccess === undefined
            ? receiver()
            : createGroupCrypto({
                access: { ...memberAccess, epoch: () => memberAccess.epoch() + hintOffset },
              }),
      }
    }),
    async sealAhead(plaintext: Uint8Array) {
      if (outstanding !== undefined) throw new Error('Outstanding registry rotation')
      outstanding = await rotate()
      return sender.handle.encrypt(plaintext)
    },
    async advance(removed?: number, applied?: (commit: Uint8Array) => Promise<void>) {
      const commit = outstanding ?? (await rotate(removed))
      await access.mutate((handle, persist) => handle.processMessage(commit, { persist }))
      outstanding = undefined
      await applied?.(commit)
    },
    async reopen() {
      fixture = await fixture.reopen()
      access = await fixture.registry.access(key.groupID)
    },
    close: () => fixture.close(),
  }
}

export async function createRegistryCryptoFixture(
  mode: Mode,
  id: string,
  backgroundMaintenance?: 'gated',
): Promise<RegistryCryptoFixture> {
  const group = await createRegistryCryptoGroup(mode, id, 2, { backgroundMaintenance })
  const topicID = 'app-topic'
  const result: RegistryCryptoFixture = {
    key: group.key,
    topicID,
    senderDID: group.sender.identity.id,
    access: async () => group.access(),
    seal: (plaintext, aad) => group.sender.handle.encrypt(plaintext, { aad }),
    sealAhead: group.sealAhead,
    advanceRegistry: () => group.advance(),
    frame: (ciphertext, position) => ({
      ...group.key,
      id: frameID(topicID, ciphertext),
      topicID,
      protocol: 'chat',
      segment: group.access().epoch(),
      position,
    }),
    armNextWorkFault: (point) => group.fixture().armNextWorkFault(point),
    resolve: (mutationID) => group.fixture().device.groups.resolve(group.key.groupID, mutationID),
    inspectRows: () => group.fixture().inspectRows(),
    async reopen() {
      await group.reopen()
      return result
    },
    close: group.close,
  }
  return result
}

export async function createRegistryPendingCryptoFixture(
  mode: Mode,
  id: string,
  backgroundMaintenance?: 'gated',
): Promise<PendingCryptoFixture> {
  const group = await createRegistryCryptoGroup(mode, `pending-${id}`, 2, { backgroundMaintenance })
  onTestFinished(group.close)
  const sender = group.members[1]
  if (sender === undefined) throw new Error('Missing pending crypto sender')
  let fail = false
  let revision = (await group.fixture().device.groups.load(group.key.groupID))?.revision ?? 0
  let liveState = encodeClientState((await group.access().read((handle) => handle)).state)
  const update = async () => {
    revision = (await group.fixture().device.groups.load(group.key.groupID))?.revision ?? revision
    liveState = encodeClientState((await group.access().read((handle) => handle)).state)
  }
  const receiver = () => {
    const crypto = group.receiver()
    return {
      ...crypto,
      async wrap(bytes: Uint8Array, opts?: Parameters<typeof crypto.wrap>[1]) {
        try {
          return await crypto.wrap(bytes, opts)
        } finally {
          await update()
        }
      },
      async unwrap(bytes: Uint8Array, opts?: Parameters<typeof crypto.unwrap>[1]) {
        const fault =
          fail && opts?.frame !== undefined && isAppLogPosition(opts.frame.position)
            ? group.fixture().armNextWorkFault('after-first-write')
            : undefined
        try {
          return await crypto.unwrap(bytes, opts)
        } finally {
          // Saved replay and refused frames can finish without entering work.
          fault?.disarm()
          await update()
        }
      },
    }
  }
  return {
    senderDID: group.sender.identity.id,
    sender: sender.crypto,
    receiver: receiver(),
    encode: (text) =>
      new TextEncoder().encode(
        JSON.stringify({ payload: { typ: 'event', prc: 'posted', data: { text } }, v: 2 }),
      ),
    frame: (ciphertext, ref) => ({ ...ref, id: frameID(ref.topicID, ciphertext) }),
    async restore() {
      await group.reopen()
      return receiver()
    },
    async probeRestored() {
      const fixture = group.fixture()
      const storage = await createStorageFixture({
        id: group.key.groupID,
        mode,
        identity: fixture.identity,
        setup: 'empty',
        rows: structuredClone(await fixture.inspectRows()),
      })
      const registry = createGroupHandleRegistry({
        persistence: storage.ports.device,
        providerID: storage.ports.device.providerID,
        recovery: fixture.environment,
        restoreCandidate: async () => {
          throw new Error('Unexpected recovery candidate')
        },
        restore: async (record) => {
          const state = decodeClientState(record.state)
          if (state === undefined) throw new Error('Invalid stored crypto state')
          return (mode === 'double' ? restoreMemoryControlHandle : restoreGroup)({
            state,
            credential: record.credential,
            ledgerEntries: record.ledger,
            options: fixture.environment.options,
          })
        },
      })
      const crypto = createGroupCrypto({ access: await registry.access(group.key.groupID) })
      return {
        async unwrap(bytes, opts) {
          try {
            return await crypto.unwrap(bytes, opts)
          } finally {
            await registry.dispose()
            await storage.close()
          }
        },
      }
    },
    failPersist: (yes) => {
      fail = yes
    },
    liveContextOwned: () => true,
    liveState: () => liveState.slice(),
    saveHandle: async () => {},
    persistCalls: () => revision,
    advance: async () => {
      await group.advance()
      await update()
    },
  }
}
