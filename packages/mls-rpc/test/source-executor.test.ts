import { PeerRemovedError } from '@kumiai/rpc'
import { describe, expect, test, vi } from 'vitest'

import { coordinatorBinding } from '../src/entry-capability.js'
import { groupBatchFor } from '../src/group-batch-binding.js'
import {
  DisplacedGroupHandleError,
  GroupUnavailableError,
  ReentrantOwnershipError,
} from '../src/persistence-errors.js'
import { createGroupHandleRegistry } from '../src/registry/registry.js'
import { createSourceExecutor, registrySourceExecutor } from '../src/registry/source-executor.js'
import { deferred } from '../src/runtime.js'
import { createDevicePackages } from './fixtures/device-packages.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { sourceExecutorFixture } from './fixtures/source-executor.js'

const inspect = async (f: Awaited<ReturnType<typeof sourceExecutorFixture>>) => {
  const binding = await f.control.admit(f.seed.key, 'source')
  return f.executor.execute({ binding, command: 'source.inspect', input: undefined })
}

describe('owned source commands', () => {
  test('admission precedes private restore under exact binding', async () => {
    const f = await sourceExecutorFixture()
    const live = await inspect(f)
    expect(live.value).toEqual({
      key: f.seed.key,
      stateVersion: 1,
      identity: f.seed.trust.installed,
    })
    expect(f.opens).not.toContain('state')
    await expect(
      f.control.admit({ ...f.seed.key, incarnation: 2 }, 'source'),
    ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
    for (const mode of ['terminal', 'restore', 'missing', 'unreadable'] as const) {
      const blocked = await sourceExecutorFixture()
      if (mode === 'terminal' || mode === 'restore') await blocked.save(mode)
      if (mode === 'missing') blocked.missingMetadata()
      if (mode === 'unreadable') blocked.unreadable('state-version')
      blocked.opens.length = 0
      await expect(inspect(blocked)).rejects.toBeInstanceOf(
        mode === 'terminal' ? PeerRemovedError : GroupUnavailableError,
      )
      expect(blocked.opens).not.toContain('state')
      expect(blocked.opens).not.toContain('trust')
    }
  })

  test('inspect waits for startup persistence before owner admission', async () => {
    const f = await sourceExecutorFixture()
    const coldWork = vi.fn(async () => 'unstarted')
    await expect(f.entry.command(f.seed.key.groupID, coldWork)).rejects.toThrow('startup')
    expect(coldWork).not.toHaveBeenCalled()
    const pause = f.pauseBarrier()
    let done = false
    const pending = inspect(f).then((result) => {
      done = true
      return result
    })
    try {
      await pause.entered
      await f.flushReady()
      expect(done).toBe(false)
      expect(f.opens).toEqual([])
    } finally {
      pause.release()
    }
    const first = await pending
    pause.restore()
    expect(first.value.stateVersion).toBe(1)
    const before = f.transactions.mock.calls.length
    await f.executor.execute({
      binding: first.binding,
      command: 'source.inspect',
      input: undefined,
    })
    // Device lifecycle may read D. The command itself never opens a G transaction.
    expect(
      f.transactions.mock.calls.slice(before).filter(([scope]) => scope.groupID !== null),
    ).toHaveLength(0)
  })

  test.each([false, true])(
    'command callbacks cannot depend on their own release (context=%s)',
    async (context) => {
      const f = await sourceExecutorFixture(
        context ? { ownershipContext: createAsyncLocalOwnershipContext() } : {},
      )
      await inspect(f)
      const entered = deferred<void>()
      const release = deferred<void>()
      const command = f.entry.command(f.seed.key.groupID, async () => {
        const roots = [
          f.persistence.load(),
          f.control.admit(f.seed.key, 'source'),
          f.executor.execute({
            binding: { key: f.seed.key, generation: 1 },
            command: 'source.inspect',
            input: undefined,
          }),
        ]
        await Promise.all(
          roots.map((root) => expect(root).rejects.toBeInstanceOf(ReentrantOwnershipError)),
        )
        entered.resolve()
        await release.promise
        if (context)
          await expect(f.persistence.groups.load(f.seed.key.groupID)).rejects.toBeInstanceOf(
            ReentrantOwnershipError,
          )
        return 'command'
      })
      try {
        await Promise.race([entered.promise, command])
        const independent = f.persistence.groups.load('independent')
        await expect(independent).resolves.toBeNull()
      } finally {
        release.resolve()
      }
      await expect(command).resolves.toBe('command')
    },
  )

  test('invalidation never revives superseded bindings', async () => {
    const f = await sourceExecutorFixture()
    const old = await inspect(f)
    f.control.invalidate(f.seed.key, new DisplacedGroupHandleError('Superseded'))
    const fresh = await inspect(f)
    expect(fresh.binding.generation).toBeGreaterThan(old.binding.generation)
    expect(() => f.control.assertCurrent(old.binding)).toThrow(DisplacedGroupHandleError)
    await expect(
      f.executor.execute({ binding: old.binding, command: 'source.inspect', input: undefined }),
    ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
    f.control.assertCurrent(fresh.binding)
    // Host-owned returned data cannot mutate the private admission projection.
    fresh.value.identity?.authenticator.fill(0)
    fresh.binding.key.incarnation = 99
    expect((await inspect(f)).value.identity?.authenticator).toEqual(
      f.seed.trust.installed.authenticator,
    )
    await f.save('replacement')
    await expect(f.control.admit(f.seed.key, 'source')).rejects.toBeInstanceOf(
      DisplacedGroupHandleError,
    )
    const newBinding = await f.control.admit({ ...f.seed.key, incarnation: 2 }, 'source')
    expect(
      (
        await f.executor.execute({
          binding: newBinding,
          command: 'source.inspect',
          input: undefined,
        })
      ).value.key.incarnation,
    ).toBe(2)
    expect(() => f.control.assertCurrent(old.binding)).toThrow(DisplacedGroupHandleError)
  })

  test('a replacement executor cannot reuse an earlier lifecycle generation', async () => {
    const f = await sourceExecutorFixture()
    const old = await inspect(f)
    const replacement = createSourceExecutor({
      persistence: f.persistence,
      entry: f.entry,
      lifecycle: f.lifecycle,
      environment: f.environment,
    })
    const binding = await replacement.control.admit(f.seed.key, 'source')
    expect(binding.generation).toBeGreaterThan(old.binding.generation)
    await expect(
      replacement.executor.execute({
        binding: old.binding,
        command: 'source.inspect',
        input: undefined,
      }),
    ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
    await expect(
      replacement.executor.execute({ binding, command: 'source.inspect', input: undefined }),
    ).resolves.toMatchObject({ value: { stateVersion: 1 } })
  })

  test('registry disposal releases executor observation and refuses saved bindings', async () => {
    const f = await sourceExecutorFixture()
    const observe = f.entry.observe.bind(f.entry)
    let observations = 0
    vi.spyOn(f.entry, 'observe').mockImplementation((groupID, onProof, afterRelease) =>
      observe(
        groupID,
        (value) => {
          observations++
          onProof(value)
        },
        afterRelease,
      ),
    )
    const unexpected = async (): Promise<never> => {
      throw new Error('Inspect must not restore private state')
    }
    const registry = createGroupHandleRegistry({
      persistence: f.persistence,
      providerID: f.persistence.providerID,
      packages: createDevicePackages(f.persistence),
      recovery: f.environment,
      restore: unexpected,
      restoreCandidate: unexpected,
    })
    const managed = registrySourceExecutor(registry)
    const binding = await managed.control.admit(f.seed.key, 'source')
    await f.save('progress')
    expect(observations).toBeGreaterThan(0)
    await registry.dispose()
    observations = 0
    await f.save('progress')
    expect(observations).toBe(0)
    await expect(
      managed.executor.execute({ binding, command: 'source.inspect', input: undefined }),
    ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
  })

  test('reopened registries never revive invalidated bindings or copied results', async () => {
    const f = await sourceExecutorFixture()
    const unexpected = async (): Promise<never> => {
      throw new Error('Inspect must not restore private state')
    }
    const openRegistry = (persistence: typeof f.persistence) => {
      return createGroupHandleRegistry({
        persistence,
        providerID: persistence.providerID,
        packages: createDevicePackages(persistence),
        recovery: f.environment,
        restore: unexpected,
        restoreCandidate: unexpected,
      })
    }
    const registry = openRegistry(f.persistence)
    const original = registrySourceExecutor(registry)
    const binding = await original.control.admit(f.seed.key, 'source')
    const result = structuredClone(
      await original.executor.execute({ binding, command: 'source.inspect', input: undefined }),
    )
    original.control.invalidate(f.seed.key, new DisplacedGroupHandleError('Superseded'))
    expect(() => original.control.assertCurrent(binding)).toThrow(DisplacedGroupHandleError)
    await registry.dispose()

    const reopened = f.reopenPersistence()
    expect(coordinatorBinding(reopened.groups)).not.toBe(coordinatorBinding(f.persistence.groups))
    const replacement = openRegistry(reopened)
    try {
      const fresh = registrySourceExecutor(replacement)
      const admitted = await fresh.control.admit(f.seed.key, 'source')
      await expect(
        fresh.executor.execute({ binding: admitted, command: 'source.inspect', input: undefined }),
      ).resolves.toMatchObject({ value: { key: f.seed.key, stateVersion: 1 } })
      for (const stale of [binding, result.binding]) {
        await expect(
          fresh.executor.execute({ binding: stale, command: 'source.inspect', input: undefined }),
        ).rejects.toBeInstanceOf(DisplacedGroupHandleError)
        expect(() => fresh.control.assertCurrent(stale)).toThrow(DisplacedGroupHandleError)
      }
      expect(admitted.generation).toBeGreaterThan(binding.generation)
      fresh.control.assertCurrent(admitted)
    } finally {
      await replacement.dispose()
    }
  })

  test('settled metadata invalidates the projection before another memory command', async () => {
    const f = await sourceExecutorFixture()
    const old = await inspect(f)
    await f.save('progress')
    await expect(
      f.executor.execute({ binding: old.binding, command: 'source.inspect', input: undefined }),
    ).rejects.toBeInstanceOf(GroupUnavailableError)
    expect((await inspect(f)).value.stateVersion).toBe(2)
    await f.save('terminal')
    await expect(inspect(f)).rejects.toBeInstanceOf(PeerRemovedError)
  })

  test('inspect commands enter the shared scheduler', async () => {
    const f = await sourceExecutorFixture()
    const binding = (await inspect(f)).binding
    const coordinator = coordinatorBinding(f.persistence.groups)
    if (coordinator === null) throw new Error('Missing coordinator')
    const scheduler = groupBatchFor(coordinator, f.seed.key.groupID)
    const release = deferred<void>()
    const order: Array<string> = []
    const active = scheduler.schedule({ source: 'burst', kind: 'open', run: () => release.promise })
    const command = f.executor
      .execute({ binding, command: 'source.inspect', input: undefined })
      .then(() => order.push('inspect'))
    const control = scheduler.schedule({
      source: 'control',
      kind: 'control',
      async run() {
        order.push('control')
      },
    })
    const read = vi.spyOn(f.entry, 'command')
    try {
      await f.flushReady()
      expect(read).not.toHaveBeenCalled()
      await expect(f.persistence.groups.load('other-group')).resolves.toBeNull()
      expect(order).toEqual([])
    } finally {
      release.resolve()
    }
    await Promise.all([active, command, control])
    expect(order).toEqual(['control', 'inspect'])
  })
})
