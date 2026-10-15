import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import type { AdoptionWrite, GroupMLS } from '@kumiai/rpc'
import ts from 'typescript'
import { expect, expectTypeOf, test } from 'vitest'

import { type SimpleHandleAccessParams, simpleHandleAccess } from '../src/access.js'
import { createGroupMLS, type GroupMLSDependencies, type GroupMLSParams } from '../src/mls.js'
import {
  buildRealCommit,
  createRealGroup,
  testGroupMLSDependencies,
} from './fixtures/real-group.js'
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

test('documented MLS constructors typecheck with the required dependencies', () => {
  const path = fileURLToPath(new URL('readme-constructors.ts', import.meta.url))
  const source = `
    import { createGroupMLS, type GroupMLSParams } from '../src/mls.js'
    declare const access: GroupMLSParams['access']
    declare const store: { control: GroupMLSParams['control'] }
    declare const identity: GroupMLSParams['identity']
    declare const entrySlot: GroupMLSParams['entrySlot']
    ${mlsExamples.map((example) => `{ const mls = ${example} }`).join('\n')}
  `
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
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === path
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([path], options, host)
  expect(
    ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([])
})

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
