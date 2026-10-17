import { randomIdentity } from '@kokuin/token'
import type { MemberCredential } from '@kumiai/mls'
import {
  CommitAuthoringRefusedError,
  commitInvite,
  commitKeyRotation,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
} from '@kumiai/mls'
import { digestAppliedCommit, type Operation } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createControlBuildPort, createPersistenceBuildSaver } from '../src/control-build.js'
import { decodeControlJournal } from '../src/control-journal.js'
import { InvalidCandidateError } from '../src/index.js'
import { createGroupMLS } from '../src/mls.js'
import { encodeStoredValue } from '../src/persistence-codec.js'
import { createRegistryHandleAccess } from '../src/registry-handle-access.js'
import { buildRevokeProofOperation } from '../src/revoke.js'
import { accessKinds, authoringAccessFixture, rotationIntent } from './fixtures/authoring-access.js'
import { testGroupMLSDependencies } from './fixtures/real-group.js'
import { createRegistryFixture, restoreHost } from './fixtures/registry.js'
import {
  buildSealedMemoryOperation,
  memoryModel,
  restoreMemoryControlHandle,
  restoreMemoryControlSource,
} from './fixtures/sealed-memory-mls.js'

for (const kind of accessKinds) {
  for (const owed of [false, true]) {
    test.each([
      'mutate',
      'persist then author',
      'proposal',
      'returned',
      'delayed',
      'refresh',
      'prepare',
      'open',
      'reconstruct',
    ] as const)(`${kind}, owed=${owed}: %s refuses private authoring`, async (path) => {
      if (path === 'open' && kind !== 'simple' && kind !== 'transactional') return
      const f = await authoringAccessFixture(kind)
      try {
        if (owed) expect((await f.owe()).kind).toBe('saved')
        const before = await f.stored()
        const control = await f.control().load()
        let saved: Uint8Array | undefined
        const attempt = async () => {
          if (path === 'mutate') return f.access.mutate(commitKeyRotation)
          if (path === 'persist then author')
            return f.access.mutate(async (handle, persist) => {
              saved = encodeClientState(handle.state)
              await persist(handle)
              return commitKeyRotation(handle)
            })
          if (path === 'proposal') return f.access.mutate((handle) => handle.proposeSelfRemoval())
          if (path === 'returned' || path === 'reconstruct') {
            if (path === 'reconstruct') await f.reconstruct()
            const handle = await f.access.read((handle) => handle)
            for (let i = 0; i < 2; i++)
              await expect(commitKeyRotation(handle)).rejects.toBeInstanceOf(
                CommitAuthoringRefusedError,
              )
            throw new CommitAuthoringRefusedError()
          }
          if (path === 'refresh')
            return f.access.readControl(async (scope) =>
              commitKeyRotation((await scope.refresh()).handle),
            )
          if (path === 'open') return f.openAccess().open(commitKeyRotation, async () => {})
          if (path === 'prepare') {
            const candidate = await f.restoreStored(before.state)
            return f.access.replace(candidate, undefined, async (handle) => {
              await commitKeyRotation(handle)
              return false
            })
          }
          const continuation = Promise.withResolvers<unknown>()
          void continuation.promise.catch(() => {})
          await f.access.mutate(async (handle) => {
            setTimeout(() => {
              Promise.resolve()
                .then(() => commitKeyRotation(handle))
                .then(continuation.resolve, continuation.reject)
            }, 0)
          })
          return continuation.promise
        }
        await expect(attempt()).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
        const after = await f.stored()
        expect(after.state).toEqual(saved ?? before.state)
        // A callback that completed normally, or an explicit save, may persist once.
        expect(after.version).toBeGreaterThanOrEqual(before.version)
        expect(after.version).toBeLessThanOrEqual(
          before.version + (path === 'delayed' || path === 'persist then author' ? 1 : 0),
        )
        expect(await f.control().load()).toEqual(control)
      } finally {
        await f.close()
      }
    })
  }
  test(`control-build builds under the permit on ${kind}`, async () => {
    const f = await authoringAccessFixture(kind)
    try {
      expect((await f.owe()).kind).toBe('saved')
      const slot = (await f.control().load()).commitOnce
      if (slot === null) throw new Error('Missing slot')
      const journal = decodeControlJournal(slot.journal)
      expect(journal.referencedProposals).toEqual([])
      expect(journal.candidateAuthenticator).toEqual(
        (await f.restoreCandidate(journal.candidate)).state.keySchedule.epochAuthenticator,
      )
    } finally {
      await f.close()
    }
  })
}

test('a cached Welcome is rejected before framing or persistence', async () => {
  const f = await authoringAccessFixture('simple', 'committer')
  try {
    const recipient = randomIdentity()
    const source = await f.restoreStored((await f.stored()).state)
    const { invite } = await createInvite({
      group: source,
      identity: f.real.committer.identity,
      recipientDID: recipient.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(recipient)
    const cached = await commitInvite(source, bundle.publicPackage, invite)
    await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
    const before = await f.control().load()
    const stored = await f.stored()
    const frame = vi.fn(async (host) => ({
      payload: host.commit,
      publishID: 'cached-welcome',
      expectedHead: null,
    }))
    const port = f.port(async (_op, permitted) => {
      const actual = await commitInvite(permitted, bundle.publicPackage, invite)
      expect(actual.welcomeMessage).not.toEqual(cached.welcomeMessage)
      return {
        commit: actual.commitMessage,
        digest: digestAppliedCommit(actual.commitMessage),
        incarnation: 1,
        epoch: Number(permitted.epoch),
        authenticatorBefore: permitted.state.keySchedule.epochAuthenticator.slice(),
        journal: encodeClientState(actual.newGroup.state),
        bodies: invite.ledgerEntries,
        welcome: { bytes: cached.welcomeMessage, recipients: [recipient.id] },
      }
    })
    expect(await port.prepareBuild(rotationIntent, frame)).toMatchObject({ kind: 'rejected' })
    expect(frame).not.toHaveBeenCalled()
    expect(await f.control().load()).toEqual(before)
    expect(await f.stored()).toEqual(stored)
  } finally {
    await f.close()
  }
})

test('candidate restoration storage faults propagate without rejecting the operation', async () => {
  const f = await authoringAccessFixture('simple')
  try {
    await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
    const before = await f.control().load()
    const stored = await f.stored()
    const failure = new Error('Storage temporarily unavailable')
    const frame = vi.fn()
    const port = createControlBuildPort({
      access: f.access,
      control: f.control(),
      build: f.build,
      restoreCandidate: async () => {
        throw failure
      },
      saveBuilt: createPersistenceBuildSaver({ persistence: f.fixture.device.groups, key: f.key }),
      now: () => 1,
      newID: () => crypto.randomUUID(),
    })
    await expect(port.prepareBuild(rotationIntent, frame)).rejects.toBe(failure)
    expect(frame).not.toHaveBeenCalled()
    expect(await f.control().load()).toEqual(before)
    expect(await f.stored()).toEqual(stored)
  } finally {
    await f.close()
  }
})

test.each([
  'missing envelope credential',
  'malformed own identity',
  'malformed peer identity',
] as const)('double candidate with %s is rejected before framing or persistence', async (fault) => {
  const f = await authoringAccessFixture('simple')
  try {
    await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
    const before = await f.control().load()
    const stored = await f.stored()
    const frame = vi.fn()
    const port = createControlBuildPort({
      access: f.access,
      control: f.control(),
      build: async (op, permitted) => {
        const actual = await f.build(op, permitted)
        const state = decodeClientState(actual.journal)
        if (state === undefined) throw new Error('Missing candidate state')
        if (fault === 'missing envelope credential') {
          return { ...actual, journal: encodeStoredValue({ state: actual.journal, ledger: [] }) }
        }
        const candidate = state
        const ownIndex = candidate.privatePath.leafIndex * 2
        const index =
          fault === 'malformed own identity'
            ? ownIndex
            : candidate.ratchetTree.findIndex(
                (node, index) => node?.nodeType === 1 && index !== ownIndex,
              )
        const leaf = candidate.ratchetTree[index]
        if (leaf?.nodeType !== 1 || !('identity' in leaf.leaf.credential))
          throw new Error('Missing candidate leaf')
        leaf.leaf.credential.identity = new TextEncoder().encode('{')
        return { ...actual, journal: encodeClientState(candidate) }
      },
      restoreCandidate: async (bytes) => {
        if (fault === 'missing envelope credential') return restoreHost(f.fixture, bytes)
        const state = decodeClientState(bytes)
        if (state === undefined) throw new InvalidCandidateError('Invalid candidate')
        return restoreMemoryControlHandle({ state, credential: f.member.handle.credential })
      },
      saveBuilt: createPersistenceBuildSaver({ persistence: f.fixture.device.groups, key: f.key }),
      now: () => 1,
      newID: () => crypto.randomUUID(),
    })
    expect(await port.prepareBuild(rotationIntent, frame)).toMatchObject({ kind: 'rejected' })
    expect(frame).not.toHaveBeenCalled()
    expect(await f.control().load()).toEqual(before)
    expect(await f.stored()).toEqual(stored)
  } finally {
    await f.close()
  }
})

test.each([
  'off-permit',
  'cached commit',
  'cached candidate',
  'wrong digest',
  'wrong epoch',
  'wrong authenticator',
  'invalid candidate',
  'empty candidate',
  'truncated version-2 candidate',
] as const)('a host commit %s is rejected before framing or persistence', async (fault) => {
  const f = await authoringAccessFixture('simple')
  try {
    let source = await f.stored()
    const bare = await f.restoreCandidate(source.state)
    const cached = await f.build(rotationIntent, bare)
    await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
    source = await f.stored()
    const before = await f.control().load()
    const frame = vi.fn(async () => ({
      payload: new Uint8Array([1]),
      publishID: 'publish',
      expectedHead: null,
    }))
    const build = async (op: Operation, permitted: GroupHandle) => {
      if (fault === 'off-permit') return cached
      const actual = await f.build(op, permitted)
      if (fault === 'cached commit') return { ...actual, commit: cached.commit }
      if (fault === 'cached candidate') return { ...actual, journal: cached.journal }
      if (fault === 'wrong digest') return { ...actual, digest: 'another-digest' }
      if (fault === 'invalid candidate') return { ...actual, journal: new Uint8Array([0]) }
      if (fault === 'empty candidate') return { ...actual, journal: new Uint8Array() }
      if (fault === 'truncated version-2 candidate') {
        expect(actual.journal[0]).toBe(2)
        return { ...actual, journal: actual.journal.slice(0, -1) }
      }
      if (fault === 'wrong epoch') return { ...actual, epoch: actual.epoch + 1 }
      return { ...actual, authenticatorBefore: new Uint8Array([1]) }
    }
    expect(await f.port(build).prepareBuild(rotationIntent, frame)).toMatchObject({
      kind: 'rejected',
      reason: 'commit not built under the control-build permit',
    })
    expect(frame).not.toHaveBeenCalled()
    expect(await f.control().load()).toEqual(before)
    expect(await f.stored()).toEqual(source)
  } finally {
    await f.close()
  }
})

function reachableObjects(value: unknown, found = new Set<object>()): Set<object> {
  if (typeof value !== 'object' || value === null || found.has(value)) return found
  found.add(value)
  if (ArrayBuffer.isView(value)) found.add(value.buffer)
  else if (value instanceof Map)
    for (const [key, entry] of value) {
      reachableObjects(key, found)
      reachableObjects(entry, found)
    }
  else for (const entry of Object.values(value)) reachableObjects(entry, found)
  return found
}

test('the permit clone is independent and exact when the live handle receives after capture', async () => {
  const f = await authoringAccessFixture('simple')
  try {
    const message = await f.remote.handle.encrypt(new Uint8Array([7]))
    await f.access.mutate((handle) => handle.encrypt(new Uint8Array([8])))
    await f.control().apply({ putOperations: [rotationIntent] }, 'intent')
    const captured = await f.stored()
    const live = await f.access.read((handle) => handle)
    const build = async (op: Operation, permitted: GroupHandle) => {
      await f.access.mutate((handle) => handle.decrypt(message))
      expect(encodeClientState(live.state)).not.toEqual(captured.state)
      const objects = reachableObjects(live.state)
      for (const object of reachableObjects(permitted.state))
        expect(objects.has(object)).toBe(false)
      expect(encodeClientState(permitted.state)).toEqual(captured.state)
      return f.build(op, permitted)
    }
    expect(
      (
        await f.port(build).prepareBuild(rotationIntent, async (host) => ({
          payload: host.commit,
          publishID: 'independent',
          expectedHead: null,
        }))
      ).kind,
    ).toBe('saved')
    const slot = (await f.control().load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    const journal = decodeControlJournal(slot.journal)
    expect(journal.sourceState).toEqual(captured.state)
    expect(slot.authenticatorBefore).toEqual(
      decodeClientState(journal.sourceState)?.keySchedule.epochAuthenticator,
    )
  } finally {
    await f.close()
  }
})

test('overlapping double builds refuse before construction and after model restoration', async () => {
  const f = await createRegistryFixture({
    mode: 'double',
    setup: 'seeded',
    groupID: 'double-permit',
  })
  try {
    const access = createRegistryHandleAccess({ access: await f.registry.access('double-permit') })
    const control = f.device.groups.ports({ groupID: 'double-permit', incarnation: 1 }).control
    const intent = { ...rotationIntent, body: encodeStoredValue({ target: randomIdentity().id }) }
    await control.apply({ putOperations: [intent] }, 'intent')
    let constructions = 0
    const restore = async ({
      state,
      credential,
      ledgerEntries,
    }: {
      state: Uint8Array
      credential: MemberCredential
      ledgerEntries: Array<string>
    }) => {
      const decoded = decodeClientState(state)
      if (decoded === undefined) throw new Error('Invalid source')
      return restoreMemoryControlSource({
        state: decoded,
        credential,
        ledgerEntries,
        options: f.environment.options,
      })
    }
    const restoreCandidate = async (bytes: Uint8Array) =>
      access.read((current) => {
        const state = decodeClientState(bytes)
        if (state === undefined) throw new InvalidCandidateError('Invalid candidate')
        return restoreMemoryControlHandle({
          state,
          credential: current.credential,
          options: f.environment.options,
        })
      })
    const port = createControlBuildPort({
      access,
      control,
      restoreSource: restore,
      restoreCandidate,
      now: () => 1,
      newID: () => crypto.randomUUID(),
      saveBuilt: createPersistenceBuildSaver({ persistence: f.device.groups, key: control.key }),
      build: async (op, handle) => {
        const model = memoryModel(handle)
        const original = model.buildCommit.bind(model)
        vi.spyOn(model, 'buildCommit').mockImplementation((...args) => {
          constructions++
          return original(...args)
        })
        const first = buildSealedMemoryOperation(op, handle)
        const second = buildSealedMemoryOperation(op, handle)
        await expect(second).rejects.toBeInstanceOf(CommitAuthoringRefusedError)
        const built = await first
        await new Promise<void>((resolve, reject) =>
          setTimeout(() => {
            buildSealedMemoryOperation(op, handle).then(
              () => reject(new Error('Late construction was allowed')),
              (error: unknown) => {
                try {
                  expect(error).toBeInstanceOf(CommitAuthoringRefusedError)
                  resolve()
                } catch (failure) {
                  reject(failure)
                }
              },
            )
          }, 0),
        )
        return built
      },
    })
    expect(
      (
        await port.prepareBuild(intent, async (built) => ({
          payload: built.commit,
          publishID: 'double',
          expectedHead: null,
        }))
      ).kind,
    ).toBe('saved')
    expect(constructions).toBe(1)
    const slot = (await control.load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    expect(decodeControlJournal(slot.journal).referencedProposals).toEqual([])
    expect(decodeControlJournal(slot.journal).candidateAuthenticator).toEqual(
      (await restoreCandidate(decodeControlJournal(slot.journal).candidate)).state.keySchedule
        .epochAuthenticator,
    )
    const issued = await access.read((handle) => handle)
    await expect(buildSealedMemoryOperation(intent, issued)).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
  } finally {
    await f.close()
  }
})

test('buildRevokeProofOperation builds on the supplied handle', async () => {
  const f = await authoringAccessFixture('simple')
  try {
    const mls = createGroupMLS({
      ...testGroupMLSDependencies(f.access, f.control()),
      identity: f.member.identity,
      entrySlot: f.member.slot,
    })
    const group = await f.restoreStored((await f.stored()).state)
    const failure = new Error('supplied proof handle')
    const readControl = f.access.readControl
    let reading = false
    f.access.readControl = (fn) =>
      readControl(async (scope) => {
        reading = true
        try {
          return await fn(scope)
        } finally {
          reading = false
        }
      })
    vi.spyOn(group, 'anchor', 'get').mockImplementation(() => {
      expect(reading).toBe(false)
      throw failure
    })
    const op = {
      ...rotationIntent,
      body: new TextEncoder().encode(
        JSON.stringify({ type: 'revoke-proof', input: { subject: f.member.identity.id, log: [] } }),
      ),
    }
    await expect(
      buildRevokeProofOperation({
        mls,
        group,
        op,
        options: { serializeJournal: () => new Uint8Array() },
      }),
    ).rejects.toBe(failure)
  } finally {
    await f.close()
  }
})

test.each([
  { referencedProposals: null },
  { referencedProposals: [1] },
  { referencedProposals: {} },
  { candidateAuthenticator: null },
  { candidateAuthenticator: [1] },
  { candidateAuthenticator: 'authenticator' },
])('journal receipt fields refuse malformed values: %j', async (fields) => {
  const f = await authoringAccessFixture('simple')
  try {
    await f.owe()
    const slot = (await f.control().load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    const journal = decodeControlJournal(slot.journal)
    expect(() => decodeControlJournal(encodeStoredValue({ ...journal, ...fields }))).toThrow(
      'Malformed control journal',
    )
    const {
      referencedProposals: _references,
      candidateAuthenticator: _authenticator,
      ...legacy
    } = journal
    expect(decodeControlJournal(encodeStoredValue(legacy))).toEqual(legacy)
  } finally {
    await f.close()
  }
})

test('the memory control envelope is stable across restoration', async () => {
  const f = await createRegistryFixture({
    mode: 'double',
    setup: 'seeded',
    groupID: 'stable-memory-source',
  })
  try {
    const record = await f.device.groups.loadState({
      groupID: 'stable-memory-source',
      incarnation: 1,
    })
    if (record === null || record.deleted || record.state === null)
      throw new Error('Missing source')
    const state = decodeClientState(record.state)
    if (state === undefined) throw new Error('Invalid source')
    const handle = await restoreMemoryControlHandle({
      state,
      credential: record.credential,
      ledgerEntries: record.ledger,
      options: f.environment.options,
    })
    expect(encodeClientState(handle.state)).toEqual(record.state)
    const intent = { ...rotationIntent, body: encodeStoredValue({ target: randomIdentity().id }) }
    await expect(buildSealedMemoryOperation(intent, handle)).rejects.toBeInstanceOf(
      CommitAuthoringRefusedError,
    )
    expect(encodeClientState(handle.state)).toEqual(record.state)
  } finally {
    await f.close()
  }
})
