import {
  type ControllerLog,
  createInception,
  createRemove,
  createReset,
  createRotate,
  didFromInception,
  digestOf,
  snapshotOf,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import { beforeAll, describe, expect, test, vi } from 'vitest'

import { foldChain } from '../src/controller-log.js'
import { createRegistryControllerResolver, prefixRelation } from '../src/embedded-resolver.js'
import { type DeviceRegistry, denySetOf, registryForLog, registrySeed } from '../src/registry.js'
import { rotateChain } from './fixtures/controller-chain.js'
import { buildEpoch, saturatedLog } from './fixtures/controller-epoch.js'

const loads = vi.hoisted(() => ({ dids: [] as Array<string>, recorded: 0 }))
vi.mock('@kokuin/controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kokuin/controller')>()
  return {
    ...actual,
    createControllerResolver: (options: Parameters<typeof actual.createControllerResolver>[0]) =>
      actual.createControllerResolver({
        ...options,
        loadLog: async (did: string) => {
          loads.dids.push(did)
          const log = await options.loadLog(did)
          if (log != null && log.events.length > 0) loads.recorded++
          return log
        },
      }),
  }
})

const seed = new Uint8Array(32).fill(7)
const inception = createInception(seed, 0)
const did = didFromInception(inception.event)
const params = { seed, profile: 0, did, chain: [inception] }
const rotation = rotateChain(params)
const rotated: ControllerLog = { chain: [inception, rotation], events: [] }

function withDenied(registry: DeviceRegistry, denied: string): DeviceRegistry {
  return {
    ...registry,
    devices: new Map([
      ...registry.devices,
      [normalizeDID(denied), { controller: did, status: 'revoked' }],
    ]),
  }
}

describe('prefixRelation', () => {
  test('recognises equal and earlier chain heads as contained', () => {
    expect(prefixRelation(rotated, [inception])).toBe('contained')
    expect(prefixRelation(rotated, rotated.chain)).toBe('contained')
  })

  test('recognises an extending prefix as ahead', () => {
    expect(prefixRelation({ chain: [inception], events: [] }, rotated.chain)).toBe('ahead')
  })

  test('contains a shared head after earlier generations have been pruned', () => {
    const reset = createReset(seed, 0, 1)
    const recorded = { chain: [inception, reset], events: [] }
    expect(prefixRelation(recorded, [inception, rotation, reset])).toBe('contained')
  })

  test('recognises an ahead head across pruned reset history', () => {
    const reset = createReset(seed, 0, 1)
    const next = rotateChain({ ...params, chain: [inception, reset] })
    const recorded = { chain: [inception, rotation, reset], events: [] }
    expect(prefixRelation(recorded, [inception, reset, next])).toBe('ahead')
  })

  test('recognises a divergent chain as forked', () => {
    const fork = rotateChain({ ...params, deny: ['did:key:fork'] })
    expect(prefixRelation(rotated, [inception, fork])).toBe('forked')
    expect(prefixRelation(rotated, [createInception(new Uint8Array(32).fill(8), 0)])).toBe('forked')
  })

  test('answers none without a recorded chain or prefix head', () => {
    expect(prefixRelation(undefined, [inception])).toBe('none')
    expect(prefixRelation({ chain: [], events: [] }, [inception])).toBe('none')
    expect(prefixRelation(rotated, [])).toBe('none')
  })
})

describe('createRegistryControllerResolver', () => {
  test('resolves the controller signing key from the embedded prefix', async () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    const resolved = await resolver.resolve(did, {})
    expect(resolved.alg).toBe('EdDSA')
    expect(resolved.publicKey).toBeInstanceOf(Uint8Array)
  })

  test('has no resolveMember without a registry, including in its frozen view', () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    expect('resolveMember' in resolver).toBe(false)
    expect('resolveMember' in resolver.frozen()).toBe(false)
  })

  test('exposes only the members verification needs', () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    expect(Object.keys(resolver).sort()).toEqual([
      'frozen',
      'method',
      'resolve',
      'resolveAgreementKey',
      'resolveDenySet',
      'resolveHistoric',
    ])
  })

  test('returns the registry deny set even without a recorded log', async () => {
    const registry = withDenied(registrySeed(), 'did:key:zDenied')
    const resolver = createRegistryControllerResolver({
      controllerID: did,
      prefix: [inception],
      registry,
    })
    expect(await resolver.resolveDenySet?.(did)).toEqual(denySetOf(registry))
  })

  test('empty deny set by default', async () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    expect((await resolver.resolveDenySet?.(did))?.size).toBe(0)
  })

  test('unknown DID never reaches an external source (loadLog returns undefined → Unknown DID)', async () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    await expect(resolver.resolve('did:kokuin:someoneElse', {})).rejects.toThrow(/Unknown DID/)
  })

  test('still forwards resolveHistoric from the base controller resolver', async () => {
    const resolver = createRegistryControllerResolver({ controllerID: did, prefix: [inception] })
    expect(typeof resolver.resolveHistoric).toBe('function')
    const resolved = await resolver.resolveHistoric?.(did, {})
    expect(resolved?.alg).toBe('EdDSA')
    expect(resolved?.publicKey).toBeInstanceOf(Uint8Array)
  })

  test('resolveMember answers an effective member with the renewed lease', async () => {
    const fixture = await buildEpoch({ members: 1, renewEvery: 1000, until: 1000 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    const resolver = createRegistryControllerResolver({
      controllerID: fixture.did,
      prefix: [fixture.inception],
      registry: registryForLog(fixture.did, fixture.log),
    })
    for (const view of [resolver, resolver.frozen()]) {
      for (const did of [member.did, normalizeDID(member.did)]) {
        await expect(
          view.resolveMember?.(fixture.did, { did, add: member.add, gen: 0 }),
        ).resolves.toEqual({
          key: { alg: 'EdDSA', publicKey: member.identity.publicKey },
          lease: 2000,
        })
      }
    }
  })

  test('resolveMember refuses a removed incarnation', async () => {
    const fixture = await buildEpoch({ members: 1 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    fixture.log.events.push(
      createRemove({
        did: fixture.did,
        head: fixture.head,
        parents: [member.add],
        signer: fixture.root,
        add: member.add,
      }),
    )
    const resolver = createRegistryControllerResolver({
      controllerID: fixture.did,
      prefix: [fixture.inception],
      registry: registryForLog(fixture.did, fixture.log),
    })
    for (const view of [resolver, resolver.frozen()]) {
      await expect(
        view.resolveMember?.(fixture.did, { did: member.did, add: member.add, gen: 0 }),
      ).rejects.toThrow(/removed/)
    }
  })

  test('resolveMember refuses when the leaf prefix is ahead of or forked from the recorded chain', async () => {
    const fixture = await buildEpoch({ members: 1 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    const chainParams = {
      seed: fixture.seed,
      profile: 0,
      did: fixture.did,
      prior: fixture.inception.event,
      snapshot: snapshotOf(fixture.head),
    }
    const rotation = createRotate(chainParams)
    const fork = createRotate({ ...chainParams, seal: digestOf('fork') })
    const cases = [
      { log: fixture.log, prefix: [...fixture.log.chain, rotation] },
      {
        log: { ...fixture.log, chain: [...fixture.log.chain, rotation] },
        prefix: [...fixture.log.chain, fork],
      },
    ]
    for (const { log, prefix } of cases) {
      const resolver = createRegistryControllerResolver({
        controllerID: fixture.did,
        prefix,
        registry: registryForLog(fixture.did, log),
      })
      for (const view of [resolver, resolver.frozen()]) {
        await expect(
          view.resolveMember?.(fixture.did, { did: member.did, add: member.add, gen: 0 }),
        ).rejects.toThrow()
        await expect(view.resolveHistoric?.(fixture.did, {})).resolves.toMatchObject({
          alg: 'EdDSA',
        })
      }
    }
  })

  test('resolveMember refuses without a recorded log, an exact incarnation, generation or DID', async () => {
    const fixture = await buildEpoch({ members: 1 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    for (const registry of [registrySeed(), registryForLog(fixture.did, fixture.log)]) {
      const resolver = createRegistryControllerResolver({
        controllerID: fixture.did,
        prefix: fixture.log.chain,
        registry,
      })
      const query = { did: member.did, add: member.add, gen: 0 }
      const queries =
        registry.controllers.size === 0
          ? [query]
          : [
              { ...query, add: digestOf('unknown incarnation') },
              { ...query, gen: 1 },
              { ...query, did: 'did:key:other-member' },
            ]
      for (const view of [resolver, resolver.frozen()]) {
        for (const query of queries) {
          await expect(view.resolveMember?.(fixture.did, query)).rejects.toThrow()
        }
      }
    }
  })

  test('frozen view keeps the registry deny set', async () => {
    const registry = withDenied(
      registryForLog(did, { chain: [inception], events: [] }),
      'did:key:zDenied',
    )
    const resolver = createRegistryControllerResolver({
      controllerID: did,
      prefix: [inception],
      registry,
    })
    for (const view of [resolver, resolver.frozen()]) {
      expect((await view.resolveDenySet?.(did))?.has('did:key:zDenied')).toBe(true)
    }
  })

  test('one frozen view loads the recorded log once', async () => {
    const fixture = await buildEpoch({ members: 1 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    const view = createRegistryControllerResolver({
      controllerID: fixture.did,
      prefix: fixture.log.chain,
      registry: registryForLog(fixture.did, fixture.log),
    }).frozen()
    loads.recorded = 0
    await view.resolve(fixture.did, {})
    await view.resolveHistoric?.(fixture.did, {})
    await view.resolveAgreementKey?.(fixture.did)
    await view.resolveMember?.(fixture.did, { did: member.did, add: member.add, gen: 0 })
    await view.resolveDenySet?.(fixture.did)
    expect(loads.recorded).toBe(1)
  })

  test('loads no DID but the controller', async () => {
    const fixture = await buildEpoch({ members: 1 })
    const member = fixture.members[0]
    if (member == null) throw new Error('Missing member')
    const resolver = createRegistryControllerResolver({
      controllerID: fixture.did,
      prefix: fixture.log.chain,
      registry: registryForLog(fixture.did, fixture.log),
    })
    loads.dids.length = 0
    const view = resolver.frozen()
    await view.resolve(fixture.did, {})
    await view.resolveHistoric?.(fixture.did, {})
    await view.resolveAgreementKey?.(fixture.did)
    await view.resolveMember?.(fixture.did, { did: member.did, add: member.add, gen: 0 })
    await view.resolveDenySet?.(fixture.did)
    expect(loads.dids.length).toBeGreaterThan(0)
    expect(new Set(loads.dids)).toEqual(new Set([fixture.did]))
    const other = 'did:kokuin:someoneElse'
    await expect(view.resolve(other, {})).rejects.toThrow(/Unknown DID/)
    await expect(view.resolveHistoric?.(other, {})).rejects.toThrow(/Unknown DID/)
    await expect(view.resolveAgreementKey?.(other)).rejects.toThrow(/Unknown DID/)
    await expect(
      view.resolveMember?.(other, { did: member.did, add: member.add, gen: 0 }),
    ).rejects.toThrow(/Unknown DID/)
    await expect(view.resolveDenySet?.(other)).rejects.toThrow(/Unknown DID/)
  })

  test('key resolution uses the prefix even when the registry has a later rotation', async () => {
    const registry = registryForLog(did, rotated)
    const resolver = createRegistryControllerResolver({
      controllerID: did,
      prefix: [inception],
      registry,
    })
    const folded = foldChain(did, [inception])
    if (!folded.ok) throw new Error(folded.reason)
    const key = folded.head.keys[0]
    if (key == null) throw new Error('Missing root key')
    for (const view of [resolver, resolver.frozen()]) {
      await expect(view.resolve(did, { kid: `#${key}` })).resolves.toMatchObject({ alg: 'EdDSA' })
      await expect(view.resolveHistoric?.(did, { kid: `#${key}` })).resolves.toMatchObject({
        alg: 'EdDSA',
      })
    }
  })
})

describe('saturated recorded log', () => {
  let log: ControllerLog
  let controller: string
  let member: { did: string; add: string; gen: number }
  let registry: DeviceRegistry

  beforeAll(async () => {
    log = await saturatedLog()
    const inception = log.chain[0]
    const add = log.events.find((signed) => signed.event.t === 'add')
    if (inception?.event.t !== 'icp' || add?.event.t !== 'add')
      throw new Error('Missing saturated fixture')
    controller = add.event.i
    member = { did: add.event.did, add: digestOf(add.event), gen: 0 }
    registry = registryForLog(controller, log)
  })

  test('resolveMember refuses on a saturated recorded log, while root-token historic resolution still answers from the prefix', async () => {
    const resolver = createRegistryControllerResolver({
      controllerID: controller,
      prefix: log.chain,
      registry,
    })
    for (const view of [resolver, resolver.frozen()]) {
      await expect(view.resolveMember?.(controller, member)).rejects.toThrow(/saturated/)
      await expect(view.resolveHistoric?.(controller, {})).resolves.toMatchObject({ alg: 'EdDSA' })
    }
  })

  test('refuses saturation before returning injected denials, including in a frozen view', async () => {
    const resolver = createRegistryControllerResolver({
      controllerID: controller,
      prefix: log.chain,
      registry: withDenied(registry, 'did:key:zDenied'),
    })
    for (const view of [resolver, resolver.frozen()]) {
      await expect(view.resolveDenySet?.(controller)).rejects.toThrow(/saturated/)
    }
  })
})
