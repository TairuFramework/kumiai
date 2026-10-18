import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import type {
  AbandonedEpochRange,
  AdoptionWrite,
  BranchAbandonedEvent,
  ForkNotice,
  GroupCondition,
  GroupMLS,
  NotMemberEvidence,
  RecoverySource,
  ReportCoverage,
  ResyncProof,
} from '@kumiai/rpc'
import ts from 'typescript'
import { expect, expectTypeOf, test } from 'vitest'

import { type SimpleHandleAccessParams, simpleHandleAccess } from '../src/access.js'
import { createCheckpointService } from '../src/checkpoint.js'
import { entryCapability } from '../src/entry-capability.js'
import * as api from '../src/index.js'
import type { ManualRecoveryStore } from '../src/manual-recovery.js'
import { createGroupMLS, type GroupMLSDependencies, type GroupMLSParams } from '../src/mls.js'
import type { RecoveryPendingReason, RegistryPeerStatus } from '../src/registry-peer.js'
import type { GroupSafety, ManualRecovery, RecoveryTarget } from '../src/safety.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
} from './fixtures/real-group.js'
import { createRegistryFixture } from './fixtures/registry.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const examples = [...readme.matchAll(/persist: (\([^)]*\) => store\.save\([^\n]*\)),/g)].map(
  (match) => match[1],
)
if (examples.length === 0) throw new Error('No documented store persistence callbacks')

const accessExamples = [
  ...readme.matchAll(/const access = (simpleHandleAccess\(\{[\s\S]*?^\}\))/gm),
].map((match) => match[1])
if (accessExamples.length === 0) throw new Error('No documented simple access constructors')

const mlsExamples = [...readme.matchAll(/const mls = (createGroupMLS\(\{[\s\S]*?^\}\))/gm)].map(
  (match) => match[1],
)
if (mlsExamples.length === 0) throw new Error('No documented MLS constructors')
const registryExamples = [
  ...readme.matchAll(/const registryPeer = (await createRegistryPeer\(\{[\s\S]*?^\}\))/gm),
].map((match) => match[1])
if (registryExamples.length === 0) throw new Error('No documented registry peer constructors')

// Every ts block in these sections compiles against the shipped surface.
const checkedSections = [
  'Checkpoints and fork notices',
  'Branch abandonment',
  'Group conditions',
  'Clearing reported halts',
  'Hub migration',
  'Successor retirement',
  'Registry app crypto',
]
const sectionExamples = checkedSections.map((heading) => {
  const start = readme.indexOf(`\n## ${heading}\n`)
  if (start < 0) throw new Error(`Missing README section: ${heading}`)
  const end = readme.indexOf('\n## ', start + 1)
  const section = readme.slice(start, end < 0 ? undefined : end)
  const blocks = [...section.matchAll(/^```ts\n([\s\S]*?)^```$/gm)].map((match) => match[1])
  if (blocks.length === 0) throw new Error(`No example in README section: ${heading}`)
  return { heading, blocks }
})

function compileExamples(name: string, source: string): Array<string> {
  const path = fileURLToPath(new URL(name, import.meta.url))
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    types: ['node'],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    file === path
      ? ts.createSourceFile(file, source, languageVersion, true)
      : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([path], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

test('documented recovery choices compile', () => {
  const source = `
    import { verifyCheckpointPair } from '@kumiai/mls'
    import { GroupSafetyHeldError, type GroupForkEvidence, type GroupMLS } from '@kumiai/rpc'
    import {
      createCheckpointService, createGroupCrypto, createGroupSafety, SpentSetCorruptError,
      type GroupKey, type GroupPersistence, type GroupSafety, type ManualRecovery, type MemoryTransaction,
      type OpenAppInput, type RecoveryTarget, type RegistryPeer,
    } from '../src/index.js'
    type Params = Parameters<typeof createCheckpointService>[0]
    declare const registry: Params['registry']
    declare const identity: Params['identity']
    declare const persistence: GroupPersistence<MemoryTransaction>
    declare const mls: GroupMLS
    declare const key: GroupKey
    declare const frames: Array<OpenAppInput>
    declare const successorKey: GroupKey
    declare const safety: GroupSafety
    declare const registryPeer: RegistryPeer
    declare const epoch: number
    declare const theirFrame: Uint8Array
    declare const evidence: GroupForkEvidence
    declare const newHub: RecoveryTarget['hub']
    declare const newCommitTopicID: string
    declare const targets: Map<string, RecoveryTarget>
    declare const app: Record<string, (...args: Array<any>) => any>
    void [verifyCheckpointPair, createCheckpointService, createGroupSafety, GroupSafetyHeldError,
      SpentSetCorruptError, registry, identity, persistence, mls, key, successorKey, safety,
      registryPeer, epoch, theirFrame, evidence, newHub, newCommitTopicID, targets, app]
    ${sectionExamples
      .flatMap(({ blocks }) => blocks)
      .map((block, index) => `async function _example${index}() {\n${block}\n}`)
      .join('\n')}
  `
  expect(compileExamples('readme-recovery.ts', source)).toEqual([])

  const resyncChoice = {
    mode: 'resync' as const,
    target: { targetID: 'hub-b', hub: {} as RecoveryTarget['hub'], commitTopicID: 'topic-b' },
    allowOpenFork: true,
  }
  expectTypeOf(resyncChoice).toMatchTypeOf<ManualRecovery>()
  expectTypeOf({ mode: 'resync' as const, targetID: 'hub-b' }).toMatchTypeOf<ManualRecovery>()
  expectTypeOf({
    mode: 'successor' as const,
    successor: { groupID: 'next', incarnation: 1 },
  }).toMatchTypeOf<ManualRecovery>()
  // The registered-target resolver keeps its signature.
  expectTypeOf<Parameters<typeof api.createGroupSafety>[0]['resolveTarget']>().toEqualTypeOf<
    (targetID: string) => Promise<RecoveryTarget>
  >()
}, 30_000)

test('documented condition handlers narrow precisely', async () => {
  type Status = Awaited<ReturnType<GroupSafety['status']>>
  const status = {} as Status
  expectTypeOf(status.condition).toEqualTypeOf<GroupCondition | null>()
  expectTypeOf(status.evidence).toEqualTypeOf<NotMemberEvidence | null>()
  const peerStatus = {} as RegistryPeerStatus
  if (peerStatus.kind === 'not-member') {
    expectTypeOf(peerStatus.retrying).toEqualTypeOf<true>()
    expectTypeOf(peerStatus.evidence).toEqualTypeOf<NotMemberEvidence>()
  }
  type Events = Awaited<ReturnType<GroupSafety['events']>>[number]
  const abandonment = {} as Extract<Events, { kind: 'branch-abandoned' }>
  expectTypeOf(abandonment).toEqualTypeOf<BranchAbandonedEvent>()
  expectTypeOf(abandonment.epochs).toEqualTypeOf<AbandonedEpochRange>()
  expectTypeOf<ForkNotice['coverage']['ownMessages']>().toEqualTypeOf<ReportCoverage>()
  expect(readme).toMatch(/retrying: true/)

  // Documented export, fact and coverage reads return defensive copies.
  const fixture = await createRegistryFixture({
    groupID: 'readme-checkpoints',
    mode: 'real-mls',
    setup: 'empty',
  })
  try {
    const key = await fixture.registry.seed(await fixture.makeHandle(0), { packageUse: null })
    const checkpoints = createCheckpointService({
      registry: fixture.registry,
      key,
      identity: fixture.identity,
    })
    const entry = entryCapability(fixture.device.groups)
    const rows = (await entry?.read(key.groupID, (reads) => reads.checkpoints())) ?? []
    const coverageRow = rows.find((row) => row.kind === 'coverage')
    const factID =
      coverageRow?.kind === 'coverage' ? coverageRow.installations.at(-1)?.id : undefined
    if (factID === undefined) throw new Error('Missing installation')
    expect(await checkpoints.signInstalled(factID)).toBeInstanceOf(Uint8Array)

    const frames = await checkpoints.exportCheckpoints(key, [0])
    expect(frames).toHaveLength(1)
    const exported = frames.map((frame) => frame.slice())
    frames[0]?.fill(0)
    expect(await checkpoints.exportCheckpoints(key, [0])).toEqual(exported)

    const fact = await checkpoints.checkpointFact(key, 0)
    if (fact === null) throw new Error('Missing fact')
    const factCopy = fact.slice()
    fact.fill(0)
    expect(await checkpoints.checkpointFact(key, 0)).toEqual(factCopy)

    const coverage = await checkpoints.checkpointCoverage(key.groupID)
    const coverageCopy = structuredClone(coverage)
    coverage.retained.length = 0
    coverage.gaps.push({ key, from: 0, through: 0, reason: 'expired' })
    expect(await checkpoints.checkpointCoverage(key.groupID)).toEqual(coverageCopy)
  } finally {
    await fixture.close()
  }
}, 30_000)

test('documented absence policy waits for corroboration', () => {
  const section = sectionExamples.find(({ heading }) => heading === 'Group conditions')
  const examples = section?.blocks.join('\n') ?? ''
  for (const used of ['evidence.responderDIDs', 'responderCount', 'status.pendingReason'])
    expect(examples).toContain(used)
  const notMemberStatus = {} as Extract<RegistryPeerStatus, { kind: 'not-member' }>
  expectTypeOf(notMemberStatus.pendingReason).toEqualTypeOf<RecoveryPendingReason | undefined>()
  type Evidence = (typeof notMemberStatus)['evidence']
  expectTypeOf<Evidence['responderDIDs']>().toEqualTypeOf<Array<string>>()
  expectTypeOf<Evidence['responderCount']>().toEqualTypeOf<number>()
  expect(readme).toMatch(/another responder DID/)
  expect(readme).toMatch(/not a protocol threshold/)
})

test('manual surface does not expose generic safety reset', () => {
  expectTypeOf<keyof GroupSafety>().toEqualTypeOf<
    | 'status'
    | 'epochAuthenticator'
    | 'reportFork'
    | 'clearHold'
    | 'recover'
    | 'events'
    | 'ackEvent'
    | 'clearTombstone'
  >()
  expectTypeOf<Parameters<GroupSafety['clearHold']>>().toEqualTypeOf<[key: api.GroupKey]>()
  expectTypeOf<keyof ManualRecoveryStore>().toEqualTypeOf<
    | 'authoriseManualRecovery'
    | 'manualRecoveryControl'
    | 'readManualRecovery'
    | 'resolveManualRecoveryTarget'
    | 'moveCurrent'
  >()
  expect(
    Object.keys(api).filter((name) =>
      /reset|lower.*floor|clear(safety|condition|floor)/i.test(name),
    ),
  ).toEqual([])
  for (const stale of [/until 2\.2e/, /deferred to 2\.2e/, /remains 2\.2e/, /assigned to 2\.2e/])
    expect(readme).not.toMatch(stale)
})

test('the public registry recovery surface exposes portable contracts and actionable errors', () => {
  expectTypeOf<api.RecoverySource>().toEqualTypeOf<RecoverySource>()
  expectTypeOf<api.ResyncProof>().toEqualTypeOf<ResyncProof>()
  expectTypeOf<api.RegistryRecoverySource>().toEqualTypeOf<RecoverySource<api.GroupRecoveryTrust>>()
  expectTypeOf<api.RegistrySwitchWrite>().toExtend<{ mutationID: string }>()
  for (const name of [
    'createGroupHandleRegistry',
    'createRegistryGroupMLS',
    'createRegistryPeer',
    'createRecoveryContinuationPort',
    'createRecoverySwitchFactory',
    'toRegistrySwitchWrite',
    'createControlBuildPort',
    'createControlValidationPort',
    'createControlAdoptionPort',
    'RecoveryCandidateError',
    'RegistryResyncRefusedError',
    'RegistryRetiringError',
    'RegistryRetireHookError',
    'RegistryRecoveryReplacementError',
    'SeedAdmissionRefusedError',
  ])
    expect(Reflect.get(api, name)).toBeTypeOf('function')
})

test('documented MLS and registry constructors typecheck with the required dependencies', () => {
  const source = `
    import { createGroupMLS, type GroupMLSParams } from '../src/mls.js'
    import {
      createRegistryPeer, createRegistryGroupMLS, createRecoveryContinuationPort, createLedgerEntrySlot,
      type RegistryPeerParams, type GroupPersistence, type MemoryTransaction,
    } from '../src/index.js'
    declare const access: GroupMLSParams['access']
    declare const store: { control: GroupMLSParams['control'] }
    declare const identity: GroupMLSParams['identity']
    declare const entrySlot: GroupMLSParams['entrySlot']
    declare const registry: RegistryPeerParams['registry']
    declare const key: RegistryPeerParams['key']
    declare const recovery: RegistryPeerParams['recovery']
    declare const target: RegistryPeerParams['target']
    declare const persistence: GroupPersistence<MemoryTransaction>
    declare const createPeerForIncarnation: RegistryPeerParams['createPeer']
    ${mlsExamples.map((example) => `{ const mls = ${example} }`).join('\n')}
    ${registryExamples.map((example) => `{ const registryPeer = ${example} }`).join('\n')}
  `
  expect(compileExamples('readme-constructors.ts', source)).toEqual([])
}, 15_000)

test.each(mlsExamples)('documented MLS reads the stored identity (example %#)', async (example) => {
  const group = await createRealGroup(1, 'readme-mls')
  const member = group.members[0]
  if (member === undefined) throw new Error('Missing member')
  const stored = createTransactionalStore(member.handle)
  const access = simpleHandleAccess({
    key: stored.control.key,
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
    stateVersion: () => stored.snapshot().revision,
  })
  const mls = runInNewContext(`(${example})`, {
    createGroupMLS,
    access,
    store: { control: stored.control },
    identity: member.identity,
    entrySlot: member.slot,
  }) as GroupMLS
  expect(await mls.readRecoverySource()).toEqual(
    await access.readControl(async ({ source }) => source),
  )
  const { request } = await mls.createRecoveryRequest('readme-capture')
  const head = (await stored.control.load()).cursor?.position ?? null
  expect(await mls.sealGroupInfo(request, head)).toBeInstanceOf(Uint8Array)
})

test('plain construction requires control and identity source dependencies', () => {
  expectTypeOf<GroupMLSParams>().toExtend<GroupMLSDependencies>()
})

test.each([false, true])('ordinary source preserves nullable identity (%s)', async (lost) => {
  const group = await createRealGroup(1, 'ordinary-source')
  const member = group.members[0]
  if (member === undefined) throw new Error('Missing member')
  const stored = createTransactionalStore(member.handle)
  const access = simpleHandleAccess({
    key: stored.control.key,
    handle: () => member.handle,
    adopt: (next) => {
      member.handle = next
    },
    stateVersion: () => stored.snapshot().revision,
  })
  const dependencies = testGroupMLSDependencies(access, stored.control)
  const expected = await dependencies.readRecoverySource()
  if (lost) expected.identity = null
  const mls = createGroupMLS({
    ...dependencies,
    readRecoverySource: async () => expected,
    identity: member.identity,
    entrySlot: member.slot,
  })
  expect(await mls.readRecoverySource()).toEqual(expected)
  expect(mls.capturedRecovery).toBeUndefined()
})

test.each(accessExamples)(
  'documented simple access uses the stored key (example %#)',
  async (example) => {
    const group = await createRealGroup(1, 'readme-access-key')
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const access = runInNewContext(`(${example})`, {
      simpleHandleAccess,
      handle: member.handle,
      groupID: member.handle.groupID,
      adopt: (next: GroupHandle) => {
        member.handle = next
      },
      store: {
        control: { key: { groupID: member.handle.groupID, incarnation: 7 } },
        loadVersion: () => 0,
        save: () => Promise.resolve(),
      },
    }) as ReturnType<typeof simpleHandleAccess>
    await access.readControl(async ({ source }) => {
      expect(source.key).toEqual({ groupID: member.handle.groupID, incarnation: 7 })
    })
  },
)

test.each(examples)(
  'documented persistence co-commits adoption writes (example %#)',
  async (example) => {
    const group = await createRealGroup(1, 'readme-persistence')
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const stored = createTransactionalStore(member.handle)
    const store = {
      save: (current: GroupHandle, write?: AdoptionWrite) => {
        return stored.save(
          stored.snapshot().revision,
          encodeClientState(current.state),
          current.ledgerTokens,
          undefined,
          write,
        )
      },
    }
    const persist = runInNewContext(`(${example})`, {
      store,
    }) as SimpleHandleAccessParams['persist']
    const access = simpleHandleAccess({
      key: { groupID: member.handle.groupID, incarnation: 1 },
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
      persist,
      stateVersion: () => stored.snapshot().revision,
    })
    const mls = createGroupMLS({
      ...testGroupMLSDependencies(access, stored.control),
      identity: member.identity,
      entrySlot: member.slot,
    })
    const write = { mutationID: 'documented-adoption', changes: { deleteRejoin: true as const } }
    await mls.processCommit(await buildRealCommit(group), {
      resolveLedgerEntries: group.resolveLedgerEntries,
      adoption: () => write,
    })
    expect(stored.snapshot().mutationID).toBe(write.mutationID)
    expect(stored.snapshot().state).toEqual(encodeClientState(member.handle.state))
  },
)
