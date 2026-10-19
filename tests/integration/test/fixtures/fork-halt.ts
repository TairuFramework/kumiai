import { createHash } from 'node:crypto'
import type { ProtocolDefinition } from '@enkaku/protocol'
import {
  commitKeyRotation,
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  ledgerEntryDigest,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  createControlAdoptionPort,
  createControlValidationPort,
  createGroupCrypto,
  createGroupMLS,
  deriveEntryKey,
  deriveRecoverySecret,
  encodeControlJournal,
  type GroupSafety,
  InvalidCandidateError,
  sealEntries,
  simpleHandleAccess,
} from '@kumiai/mls-rpc'
import {
  asLogPosition,
  type BuiltCommit,
  type CertifiedControlRange,
  commitTopic,
  createControlSearch,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupForkEvidence,
  type GroupPeer,
  type GroupSafetyEvent,
  HANDSHAKE_KIND,
  type LogHub,
  type RecoveryEvent,
  type StrandObservation,
} from '@kumiai/rpc'
import { expect, vi } from 'vitest'

import { createCheckpointService } from '../../../../packages/mls-rpc/src/checkpoint.js'
import { entryCapability } from '../../../../packages/mls-rpc/src/entry-capability.js'
import {
  createControlBuildPort,
  createLedgerEntrySlot,
  createPersistenceBuildSaver,
  createRecoveryContinuationPort,
  createRegistryGroupMLS,
  createRegistryPeer,
  type RegistryHandleAccess,
  type RegistryPeer,
} from '../../../../packages/mls-rpc/src/index.js'
import {
  decodeStoredValue,
  encodeStoredValue,
} from '../../../../packages/mls-rpc/src/persistence-codec.js'
import { recoveryTrustFor } from '../../../../packages/mls-rpc/src/registry/trust.js'
import {
  bareTestHandle,
  createRealGroup,
  type RealMember,
  testGroupMLSDependencies,
} from '../../../../packages/mls-rpc/test/fixtures/real-group.js'
import {
  createRegistryFixture,
  type RegistryFixture,
  registryFixtureRestore,
} from '../../../../packages/mls-rpc/test/fixtures/registry.js'
import { writeInstallationCheckpoint } from '../../../../packages/mls-rpc/test/fixtures/storage-seed.js'
import * as muxModule from '../../../../packages/rpc/src/hub-mux.js'
import { createGroupPeerWithControlWalk } from '../../../../packages/rpc/src/peer.js'
import type { EpochRuntime, EpochRuntimeParams } from '../../../../packages/rpc/src/peer-epoch.js'
import * as epochModule from '../../../../packages/rpc/src/peer-epoch.js'
import { FakeHub } from '../../../../packages/rpc/test/fixtures/fake-hub.js'
import { chat, type Protocols } from '../app-lane-e2e.js'

export async function createCapturedRecoveryFixture(
  params: { timeoutMs?: number; deadlineMs?: number } = {},
) {
  const real = await createRealGroup(2, `captured-recovery-${crypto.randomUUID()}`)
  const admin = real.members[0]
  if (admin === undefined) throw new Error('Missing recovery administrator')
  const role = await signLedgerEntry(real.committer.identity, {
    type: 'kumiai.role',
    groupID: admin.handle.groupID,
    subject: admin.identity.id,
    value: 'admin',
  })
  real.bodies.set(ledgerEntryDigest(role), role)
  const promoted = await commitLedgerEntries(real.committer.handle, [role])
  real.committer.handle = promoted.newGroup
  for (const member of real.members) await member.handle.processMessage(promoted.commitMessage)
  const hub = new FakeHub()
  const groupID = real.committer.handle.groupID
  const target = {
    targetID: 'integration-hub',
    topicID: commitTopic(await deriveRecoverySecret(real.committer.handle)),
  }
  const devices: Array<Awaited<ReturnType<typeof device>>> = []
  async function device(realMember: RealMember) {
    const entrySlot = createLedgerEntrySlot()
    let fixture = await createRegistryFixture({
      mode: 'real-mls',
      setup: 'empty',
      groupID,
      identity: realMember.identity,
      options: { resolveLedgerEntries: entrySlot.resolve },
    })
    const key = { groupID, incarnation: 1 }
    await fixture.installRows({
      key,
      state: {
        ...key,
        version: 1,
        deleted: false,
        terminal: false,
        epoch: Number(realMember.handle.epoch),
        epochAuthenticator: realMember.handle.state.keySchedule.epochAuthenticator.slice(),
        state: encodeClientState(realMember.handle.state),
        credential: realMember.handle.credential,
        ledger: realMember.handle.ledgerTokens,
        senderHWM: 0,
      },
      trust: recoveryTrustFor(realMember.handle, key, null),
    })
    let owner: RegistryPeer
    let currentPeer: GroupPeer<Protocols> | null = null
    const controls = new Map<number, ReturnType<typeof fixture.device.groups.ports>>()
    const control = (incarnation: number) => {
      let ports = controls.get(incarnation)
      if (ports === undefined) {
        ports = fixture.device.groups.ports({ groupID, incarnation })
        controls.set(incarnation, ports)
      }
      return ports
    }
    const created: Array<{ key: typeof key; mls: ReturnType<typeof createGroupMLS> }> = []
    const hooks: {
      beforePeer?: (requested: { groupID: string; incarnation: number }) => Promise<void>
    } = {}
    const start = async (startKey = key) => {
      owner = await createRegistryPeer({
        registry: fixture.registry,
        key: startKey,
        recovery: fixture.environment,
        target,
        continuation: createRecoveryContinuationPort({
          registry: fixture.registry,
          persistence: fixture.device.groups,
        }),
        createMLS: (current) =>
          createRegistryGroupMLS({
            registry: fixture.registry,
            key: current,
            recovery: fixture.environment,
            target,
            identity: realMember.identity,
            entrySlot,
          }),
        createPeer: async (current, options) => {
          await hooks.beforePeer?.(current)
          created.push({ key: current, mls: options.mls })
          const ports = control(current.incarnation)
          const opened = async () => {
            const access = await fixture.registry.access(current.groupID)
            expect(access.key).toEqual(current)
            return access
          }
          const access: RegistryHandleAccess = {
            get key() {
              return current
            },
            get runtime(): never {
              throw new TypeError('unused')
            },
            stateVersion: () => {
              throw new TypeError('unused')
            },
            onRetire: () => {
              throw new TypeError('unused')
            },
            epoch: () => options.mls.sendAdmission().epoch,
            admission: () => options.mls.sendAdmission(),
            read: async (fn) => (await opened()).read(fn),
            readControl: async (fn) => (await opened()).readControl(fn),
            mutate: async (fn, write) => (await opened()).mutate(fn, write),
            replace: async (next, write, prepare) => (await opened()).replace(next, write, prepare),
            adopt: async (next, expected, write) => (await opened()).adopt(next, expected, write),
            seal: async (plaintext, opts) => (await opened()).seal(plaintext, opts),
            receive: async (frames) => (await opened()).receive(frames),
            onRotationRequired: () => {
              throw new TypeError('unused')
            },
            openBatch: async (frames) => (await opened()).openBatch(frames),
            pending: {
              list: async () => (await opened()).pending.list(),
              complete: async (id) => (await opened()).pending.complete(id),
            },
          }
          const restoreCandidate = async (bytes: Uint8Array) => {
            let saved: {
              state: Uint8Array
              credential: GroupHandle['credential']
              ledger: Array<string>
            }
            try {
              saved = decodeStoredValue(bytes) as typeof saved
              if (!(saved?.state instanceof Uint8Array))
                throw new InvalidCandidateError('Invalid candidate state')
            } catch (cause) {
              throw new InvalidCandidateError('Invalid candidate envelope', { cause })
            }
            const state = decodeClientState(saved.state)
            if (state === undefined) throw new InvalidCandidateError('Invalid candidate state')
            return restoreGroup({
              state,
              credential: saved.credential,
              ledgerEntries: saved.ledger,
              options: fixture.environment.options,
            })
          }
          const build = createControlBuildPort({
            access,
            control: ports.control,
            restoreCandidate,
            saveBuilt: createPersistenceBuildSaver({
              persistence: fixture.device.groups,
              key: current,
            }),
            now: Date.now,
            newID: () => crypto.randomUUID(),
            build: async (operation, handle) => {
              const body = JSON.parse(new TextDecoder().decode(operation.body)) as {
                tokens?: Array<string>
              }
              const tokens = body.tokens ?? []
              const rotated =
                tokens.length === 0
                  ? await commitKeyRotation(handle)
                  : await commitLedgerEntries(handle, tokens)
              return {
                commit: rotated.commitMessage,
                bodies: tokens,
                welcome: null,
                epoch: Number(handle.epoch),
                incarnation: current.incarnation,
                authenticatorBefore: handle.state.keySchedule.epochAuthenticator.slice(),
                digest: digestAppliedCommit(rotated.commitMessage),
                journal: encodeStoredValue({
                  state: encodeClientState(rotated.newGroup.state),
                  credential: rotated.newGroup.credential,
                  ledger: rotated.newGroup.ledgerTokens,
                }),
              }
            },
          })
          const peer = createGroupPeerWithControlWalk<Protocols>({
            ...options,
            hub,
            localDID: realMember.identity.id,
            protocols: { chat },
            handlers: {
              chat: {
                'chat/changed': () => {},
                'chat/posted': () => {},
                'chat/double': () => ({}),
              },
            },
            crypto: createGroupCrypto({ access }),
            control: ports.control,
            prepareBuild: build.prepareBuild,
            validation: createControlValidationPort({
              identity: realMember.identity,
              options: fixture.environment.options,
              restoreCandidate,
            }),
            adopt: createControlAdoptionPort({ access, control: ports.control, restoreCandidate })
              .adopt,
            readEvidence: () => fixture.device.groups.readEvidence(current),
            anchorStore: ports.anchor,
            appCursorStore: ports.cursor,
            appOutbox: ports.outbox,
            appOutboxLimit: 128,
            operationTimeoutMs: 10_000,
            deliverWelcome: async () => {
              throw new Error('Unexpected Welcome delivery')
            },
            recovery: {
              timeoutMs: params.timeoutMs ?? 100,
              deadlineMs: params.deadlineMs ?? 10_000,
              getDelayMs: () => 0,
            },
          }).peer
          currentPeer = peer
          return peer
        },
      })
      await owner.ready
    }
    const result = {
      key,
      created,
      hooks,
      identity: realMember.identity,
      get fixture() {
        return fixture
      },
      get owner() {
        return owner
      },
      get peer() {
        if (currentPeer === null || owner.peer() !== currentPeer) throw new Error('No active peer')
        return currentPeer
      },
      get mls() {
        const current = created.at(-1)
        if (current === undefined) throw new Error('No active MLS port')
        return current.mls
      },
      get control() {
        return control(1).control
      },
      async stop() {
        owner.dispose()
        await owner.drained()
      },
      async restart() {
        await result.stop()
        fixture = await fixture.reopen()
        controls.clear()
        await start(
          (await fixture.device.groups.load(groupID))?.activeIncarnation === 2
            ? { groupID, incarnation: 2 }
            : key,
        )
      },
      async close() {
        await result.stop()
        await fixture.close()
      },
    }
    await start()
    await result.peer.replay()
    return result
  }
  try {
    for (const member of real.members) devices.push(await device(member))
  } catch (error) {
    for (const member of devices) await member.close()
    throw error
  }
  const alice = devices[0]
  const bob = devices[1]
  if (alice === undefined || bob === undefined) throw new Error('Missing recovery devices')
  return {
    real,
    hub,
    alice,
    bob,
    topicID: target.topicID,
    target,
    async close() {
      for (const member of devices) await member.close()
    },
  }
}

export async function makeCheckpointPeer(
  registry: RegistryFixture,
  real: RealMember,
  hub: LogHub,
  callbacks: {
    onSafetyEvent?: (event: GroupSafetyEvent) => void | Promise<void>
    onStrand?: (event: StrandObservation) => void | Promise<void>
    onRecovery?: (event: RecoveryEvent) => void | Promise<void>
  } = {},
  recovery = { timeoutMs: 150, deadlineMs: 3000, getDelayMs: () => 0 },
) {
  const groups = registry.device.groups
  const key = { groupID: real.handle.groupID, incarnation: 1 }
  const ports = groups.ports(key)
  const row = await groups.loadState(key)
  if (row === null || row.deleted || row.state === null) throw new Error('Missing real MLS state')
  let handle = await registryFixtureRestore(registry)({ ...row, state: row.state })
  const entry = entryCapability(groups)
  if (entry === null) throw new Error('Missing persistence entry binding')
  const access = simpleHandleAccess({
    key,
    handle: () => handle,
    stateVersion: async () => {
      const current = await groups.loadState(key)
      if (current === null) throw new Error('Missing state version')
      return current.version
    },
    adopt: (next) => {
      handle = next
    },
    persist: async (next, write) => {
      const mutationID = write?.mutationID ?? crypto.randomUUID()
      await entry.run(
        { groupID: key.groupID, mutationID },
        async (reads) => ({
          expected: await reads.lifetime(),
          value: { state: await reads.state(key.incarnation), trust: await reads.trust() },
        }),
        async (stores, previous) => {
          if (previous.state === null || previous.state.deleted)
            throw new Error('Missing persisted source')
          const target = stores.incarnation(key.incarnation)
          await target.state.save(
            {
              ...previous.state,
              state: encodeClientState(next.state),
              credential: next.credential,
              ledger: next.ledgerTokens,
              version: previous.state.version + 1,
              deleted: false,
              terminal: next.state.groupActiveState.kind === 'removedFromGroup',
              epoch: Number(next.epoch),
              epochAuthenticator: next.state.keySchedule.epochAuthenticator.slice(),
            },
            write?.expected,
          )
          await stores.trust.save(recoveryTrustFor(next, key, previous.trust))
          await writeInstallationCheckpoint(stores, {
            key,
            handle: next,
            mutationID,
            stateVersion: previous.state.version + 1,
          })
          if (write !== undefined) await target.control.apply(write.changes, mutationID)
        },
      )
    },
  })
  const cryptoPort = createGroupCrypto({ access })
  const mls = createGroupMLS({
    ...testGroupMLSDependencies(access, ports.control),
    identity: real.identity,
    entrySlot: real.slot,
  })
  const restoreCandidate = async (bytes: Uint8Array) => {
    let saved: {
      state: Uint8Array
      credential: GroupHandle['credential']
      ledger: Array<string>
    }
    try {
      saved = decodeStoredValue(bytes) as typeof saved
      if (!(saved?.state instanceof Uint8Array))
        throw new InvalidCandidateError('Invalid candidate state')
    } catch (cause) {
      throw new InvalidCandidateError('Invalid candidate envelope', { cause })
    }
    const state = decodeClientState(saved.state)
    if (state === undefined) throw new InvalidCandidateError('Invalid candidate state')
    return restoreGroup({
      state,
      credential: saved.credential,
      ledgerEntries: saved.ledger,
      options: { resolveLedgerEntries: real.slot.resolve },
    })
  }
  const validation = createControlValidationPort({
    identity: real.identity,
    options: { resolveLedgerEntries: real.slot.resolve },
    restoreCandidate,
  })
  const adoption = createControlAdoptionPort({ access, control: ports.control, restoreCandidate })
  const prepareBuild = vi.fn(async () => {
    throw new Error('Unexpected control build in receive-only fixture')
  })
  const readEvidence = vi.fn(() => groups.readEvidence(key))
  const { peer, controlWalk } = createGroupPeerWithControlWalk<Protocols>({
    ...callbacks,
    appOutboxLimit: 128,
    deliverWelcome: async () => {
      throw new Error('Unexpected Welcome obligation')
    },
    hub,
    crypto: cryptoPort,
    checkpoints: createCheckpointService({
      registry: registry.registry,
      key,
      identity: real.identity,
    }),
    mls,
    control: ports.control,
    prepareBuild,
    validation,
    adopt: adoption.adopt,
    readEvidence,
    anchorStore: ports.anchor,
    appCursorStore: ports.cursor,
    appOutbox: ports.outbox,
    localDID: real.identity.id,
    protocols: { chat },
    handlers: {
      chat: { 'chat/changed': () => {}, 'chat/posted': () => {}, 'chat/double': () => ({}) },
    },
    recovery,
  })
  return {
    peer,
    controlWalk,
    access,
    control: ports.control,
    crypto: cryptoPort,
    mls,
    validation,
    prepareBuild,
    readEvidence,
  }
}

export type ForkPeer = Awaited<ReturnType<typeof makeCheckpointPeer>>
export type ForkFixture = Awaited<ReturnType<typeof createForkFixture>>

export async function createForkFixture(recovery?: Parameters<typeof makeCheckpointPeer>[4]) {
  const groupID = `fork-halt-${crypto.randomUUID()}`
  const real = await createRealGroup(1, groupID)
  const receiver = real.members[0]
  if (receiver === undefined) throw new Error('Missing real receiver')
  const hub = new FakeHub()
  const key = { groupID, incarnation: 1 }
  const topic = commitTopic(await deriveRecoverySecret(receiver.handle))
  let registry = await createRegistryFixture({
    mode: 'real-mls',
    setup: 'empty',
    groupID,
    identity: receiver.identity,
    options: { resolveLedgerEntries: real.resolveLedgerEntries },
  })
  async function install(target: RegistryFixture, handle: GroupHandle) {
    await target.installRows({
      key,
      state: {
        ...key,
        version: 1,
        deleted: false,
        terminal: false,
        epoch: Number(handle.epoch),
        epochAuthenticator: handle.state.keySchedule.epochAuthenticator.slice(),
        state: encodeClientState(handle.state),
        credential: handle.credential,
        ledger: handle.ledgerTokens,
        senderHWM: 0,
      },
      trust: recoveryTrustFor(handle, key, null),
    })
  }
  await install(registry, receiver.handle)
  const onSafetyEvent = vi.fn<(event: GroupSafetyEvent) => void | Promise<void>>()
  const onStrand = vi.fn<(event: StrandObservation) => void>()
  const onRecovery = vi.fn<(event: RecoveryEvent) => void>()
  let member = await makeCheckpointPeer(
    registry,
    receiver,
    hub,
    { onSafetyEvent, onStrand, onRecovery },
    recovery,
  )
  const peers = [member]
  const extraRegistries: Array<RegistryFixture> = []
  await member.peer.replay()

  async function publish(commit: Uint8Array, source: GroupHandle, expectedHead?: string | null) {
    return hub.publish({
      topicID: topic,
      senderDID: real.committer.identity.id,
      retain: 'log',
      ...(expectedHead === undefined ? {} : { expectedHead }),
      payload: encodeHandshakeFrame(
        HANDSHAKE_KIND.commit,
        encodeCommitFrame(
          commit,
          sealEntries(await deriveEntryKey(source), encodeLedgerEntries([])),
        ),
      ),
    })
  }
  const fixture = {
    real,
    identity: receiver.identity,
    hub,
    key,
    topic,
    onSafetyEvent,
    onStrand,
    onRecovery,
    get member() {
      return member
    },
    get registry() {
      return registry
    },
    safety: (): GroupSafety => registry.safety(),
    publish,
    async authenticatorEvidence(): Promise<GroupForkEvidence & { kind: 'epoch-authenticator' }> {
      const identity = await fixture.safety().epochAuthenticator(key)
      if (identity === null) throw new Error('Missing committed authenticator')
      const remote = (
        await registry.makeHandle(identity.epoch)
      ).state.keySchedule.epochAuthenticator.slice()
      if (remote.every((byte, index) => byte === identity.authenticator[index]))
        throw new Error('Independent real MLS branches must differ')
      return {
        kind: 'epoch-authenticator',
        epoch: identity.epoch,
        local: identity.authenticator,
        remote,
      }
    },
    async competing(branch: 'losing' | 'winning') {
      const retained = await registry.device.groups.readEvidence(key)
      await fixture.stopPeer()
      const source = real.committer.handle
      const first = await commitKeyRotation(await bareTestHandle(source))
      const second = await commitKeyRotation(await bareTestHandle(source))
      const firstRow = await publish(first.commitMessage, source, null)
      await expect(publish(second.commitMessage, source, null)).rejects.toMatchObject({
        name: 'HeadMismatchError',
      })
      const secondRow = await publish(second.commitMessage, source)
      const applied = branch === 'losing' ? secondRow : firstRow
      const remote = branch === 'losing' ? firstRow : secondRow
      const local = branch === 'losing' ? second : first
      const following = await commitKeyRotation(local.newGroup)
      const nextRow = await publish(following.commitMessage, local.newGroup)
      hub.hideFrom(receiver.identity.id, nextRow.sequenceID)
      const localCommit = branch === 'losing' ? second.commitMessage : first.commitMessage
      const remoteCommit = branch === 'losing' ? first.commitMessage : second.commitMessage
      // Even a signed CAS loser remains safe to deliver at any log position.
      hub.hideFrom(receiver.identity.id, remote.sequenceID)
      let revealing = false
      const fetch = hub.fetchTopic.bind(hub)
      vi.spyOn(hub, 'fetchTopic').mockImplementation(async (params) => {
        const page = await fetch(params)
        return params.topicID === topic && !revealing ? { ...page, head: applied.sequenceID } : page
      })
      await fixture.restart()
      const evidence = {
        kind: 'digest-divergence' as const,
        epoch: Number(source.epoch),
        position: remote.sequenceID,
        localDigest: createHash('sha256').update(localCommit).digest('base64url'),
        remoteDigest: createHash('sha256').update(remoteCommit).digest('base64url'),
      }
      if (evidence.localDigest === evidence.remoteDigest) throw new Error('Commits must compete')
      const snapshot = await member.control.load()
      if (snapshot.applied[0]?.digest !== evidence.localDigest)
        throw new Error('Real commit was not applied')
      return {
        evidence,
        appliedPosition: applied.sequenceID,
        async certify(): Promise<CertifiedControlRange> {
          if (branch !== 'winning') throw new Error('Certification requires the first valid winner')
          const built = await commitKeyRotation(await bareTestHandle(receiver.handle))
          const payload = encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(
              built.commitMessage,
              sealEntries(await deriveEntryKey(receiver.handle), encodeLedgerEntries([])),
            ),
          )
          const slot: BuiltCommit = {
            incarnation: key.incarnation,
            epoch: Number(receiver.handle.epoch),
            authenticatorBefore: receiver.handle.state.keySchedule.epochAuthenticator.slice(),
            searchFrom: null,
            expectedHead: null,
            publishID: crypto.randomUUID(),
            payload,
            payloadDigest: createHash('sha256').update(payload).digest('base64url'),
            digest: digestAppliedCommit(built.commitMessage),
            bodies: [],
            welcome: null,
            journal: encodeControlJournal({
              version: 1,
              source: retained.source,
              checkpoint: null,
              sourceState: encodeClientState(receiver.handle.state),
              sourceCredential: receiver.handle.credential,
              sourceLedger: receiver.handle.ledgerTokens,
              candidate: encodeStoredValue({
                state: encodeClientState(built.newGroup.state),
                credential: built.newGroup.credential,
                ledger: built.newGroup.ledgerTokens,
              }),
            }),
          }
          revealing = true
          hub.revealTo(receiver.identity.id, remote.sequenceID)
          const certificates: Array<CertifiedControlRange> = []
          const search = createControlSearch({
            budget: { maxPasses: 2, maxFetches: 16, maxFrames: 256 },
            fetch: async (after) => {
              const page = await fetch({
                subscriberDID: receiver.identity.id,
                topicID: topic,
                ...(after === null ? {} : { after }),
              })
              return { ...page, head: secondRow.sequenceID }
            },
            validation: member.validation,
            readEvidence: member.readEvidence,
            safetyHold: member.controlWalk.safetyHold,
            haltFork: member.controlWalk.haltFork,
            hold: async () => {
              throw new Error('Unexpected certification hold')
            },
            followWinner: async (frame, range, work) => {
              await member.controlWalk.walkCommits({ through: range.through, range, work })
              certificates.push(range)
              return { kind: 'applied', position: frame.position }
            },
            reconcileAbsent: async () => true,
          })
          await search.searchLog(slot)
          const certificate = certificates[0]
          if (certificate === undefined || certificate.losers.length !== 1)
            throw new Error('Missing validated loser certificate')
          return certificate
        },
        async reveal(options: { following?: boolean; range?: CertifiedControlRange } = {}) {
          revealing = true
          hub.revealTo(receiver.identity.id, remote.sequenceID)
          if (options.following !== false) hub.revealTo(receiver.identity.id, nextRow.sequenceID)
          return member.controlWalk.walkCommits({
            through: asLogPosition(nextRow.sequenceID),
            range: options.range ?? null,
            work: { takeFetch: () => true, takeFrame: () => true },
          })
        },
      }
    },
    async stopPeer() {
      await member.peer.dispose()
      await member.peer.drained()
    },
    async restart(
      options: { beforeReady?: (fixture: { member: ForkPeer; hub: FakeHub }) => void } = {},
    ) {
      await fixture.stopPeer()
      registry = await registry.reopen()
      member = await makeCheckpointPeer(
        registry,
        receiver,
        hub,
        { onSafetyEvent, onStrand, onRecovery },
        recovery,
      )
      peers.push(member)
      options.beforeReady?.(fixture)
      await member.peer.outcomes()
    },
    async survivor() {
      const other = await createRegistryFixture({
        mode: 'real-mls',
        setup: 'empty',
        groupID,
        identity: real.committer.identity,
        options: { resolveLedgerEntries: real.resolveLedgerEntries },
      })
      extraRegistries.push(other)
      await install(other, real.committer.handle)
      const survivor = await makeCheckpointPeer(other, real.committer, hub, {}, recovery)
      peers.push(survivor)
      await survivor.peer.replay()
      return survivor
    },
    async close() {
      for (const current of peers) await current.peer.dispose()
      for (const current of peers) await current.peer.drained()
      await registry.close()
      for (const other of extraRegistries) await other.close()
    },
  }
  return fixture
}

export function observeForkWork(fixture: { member: ForkPeer; hub: FakeHub }) {
  const { member, hub } = fixture
  member.readEvidence.mockClear()
  const ephemeral = vi.fn<(params: Parameters<FakeHub['publish']>[0]) => void>()
  const publish = vi.spyOn(hub, 'publish')
  const send = publish.getMockImplementation() ?? FakeHub.prototype.publish
  publish.mockImplementation(async (params) => {
    if (params.retain !== 'log') ephemeral(params)
    return send.call(hub, params)
  })
  return {
    publish,
    ephemeral,
    epoch: vi.spyOn(member.mls, 'readEpoch'),
    evidence: member.readEvidence,
    secret: vi.spyOn(member.crypto, 'exportSecret'),
    wrap: vi.spyOn(member.crypto, 'wrap'),
    unwrap: vi.spyOn(member.crypto, 'unwrap'),
    sealEntries: vi.spyOn(member.crypto, 'sealEntries'),
    openEntries: vi.spyOn(member.crypto, 'openEntries'),
    recoverySecret: vi.spyOn(member.mls, 'exportRecoverySecret'),
    process: vi.spyOn(member.mls, 'processCommit'),
    groupInfo: vi.spyOn(member.mls, 'sealGroupInfo'),
    ledger: vi.spyOn(member.mls, 'sealLedger'),
    verdict: vi.spyOn(member.mls, 'sealRecoveryVerdict'),
    request: vi.spyOn(member.mls, 'createRecoveryRequest'),
    recovery: vi.spyOn(member.mls, 'applyRecovery'),
    validation: vi.spyOn(member.validation, 'restoreValidation'),
    build: member.prepareBuild,
  }
}

export function observeStartup(hub: FakeHub) {
  const retain = vi.fn<(...args: Array<unknown>) => void>()
  const start = vi.fn<() => void>()
  const buildEpoch = vi.fn<() => void>()
  const createMux = muxModule.createHubMux
  vi.spyOn(muxModule, 'createHubMux').mockImplementation((params) => {
    const mux = createMux(params)
    const originalRetain = mux.retainTopic
    const originalStart = mux.start
    mux.retainTopic = (...args) => {
      retain(...args)
      originalRetain(...args)
    }
    mux.start = () => {
      start()
      originalStart()
    }
    return mux
  })
  const epochFactory = epochModule as unknown as {
    createEpochRuntime: (
      params: EpochRuntimeParams<Record<string, ProtocolDefinition>>,
    ) => EpochRuntime
  }
  const createEpoch = epochFactory.createEpochRuntime
  vi.spyOn(epochFactory, 'createEpochRuntime').mockImplementation((params) => {
    const runtime = createEpoch(params)
    const originalBuild = runtime.buildEpoch
    runtime.buildEpoch = async () => {
      buildEpoch()
      await originalBuild()
    }
    return runtime
  })
  const counters = {
    receive: vi.spyOn(hub, 'receive'),
    subscribe: vi.spyOn(hub, 'subscribe'),
    fetch: vi.spyOn(hub, 'fetchTopic'),
    publish: vi.spyOn(hub, 'publish'),
    retain,
    start,
    buildEpoch,
  }
  for (const counter of Object.values(counters)) counter.mockClear()
  return counters
}
