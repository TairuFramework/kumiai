import { describe, expect, test } from 'vitest'

import type * as Mirror from '../../rpc-conformance/src/index.js'
import * as Memory from '../../rpc-conformance/src/memory-control-store.js'
import * as Rpc from '../src/index.js'

const key: Rpc.GroupKey = { groupID: 'g', incarnation: 2 }
const halt = (): Rpc.ForkHalt => ({
  eventID: '["group:fork","g",2]',
  evidence: {
    kind: 'epoch-authenticator',
    epoch: 4,
    local: new Uint8Array([1, 2]),
    remote: new Uint8Array([3, 4]),
  },
  detectedAt: 100,
})
const unavailable = (): Rpc.RecoveryUnavailableEvent => ({
  ...key,
  id: '["group:recovery-unavailable","g",2]',
  kind: 'group:recovery-unavailable',
  reason: 'trust-unreadable',
})
const empty = (): Rpc.ControlSnapshot => ({
  commitOnce: null,
  commitOnceAcceptance: null,
  controlHold: null,
  forkHalt: null,
  recoveryUnavailable: null,
  strand: null,
  operations: [],
  rejoin: null,
  recoveryEpochFloor: null,
  settledRejoins: [],
  outcomes: [],
  welcomes: [],
  applied: [],
  responses: [],
  cursor: null,
})

describe('control safety fields', () => {
  test.each(['app-report', 'internal'] as const)(
    'preserves producer %s and reads it once',
    async (producer) => {
      const expected = { ...halt(), producer }
      for (const source of ['RPC', 'independent double'] as const) {
        let reads = 0
        const value = Object.defineProperty(halt(), 'producer', {
          get: () => (++reads === 1 ? producer : 'invalid'),
        })
        const result =
          source === 'RPC'
            ? Rpc.applyChanges(empty(), { forkHalt: value }, null, key)
            : await (async () => {
                const store = Memory.createMemoryControlStore(key)
                await store.apply({ forkHalt: value }, 'report')
                return store.load()
              })()
        expect(reads).toBe(1)
        expect(result.forkHalt).toEqual(expected)
      }
    },
  )

  test.each(['other', null, 1])(
    'rejects unknown producer %j in both reducers',
    async (producer) => {
      const changes = { forkHalt: { ...halt(), producer } } as unknown as Rpc.ControlChanges
      expect(() => Rpc.applyChanges(empty(), changes, null, key)).toThrow(TypeError)
      const store = Memory.createMemoryControlStore(key)
      await expect(store.apply(changes, 'invalid-producer')).rejects.toThrow(TypeError)
      expect((await store.load()).forkHalt).toBeNull()
      expect(await store.lastMutation()).toBeNull()
    },
  )

  test.each([undefined, 'app-report', 'internal'] as const)(
    'producer %s cannot be reclassified while held',
    async (producer) => {
      const original = { ...halt(), ...(producer === undefined ? {} : { producer }) }
      const replacement = {
        ...halt(),
        producer: producer === 'app-report' ? ('internal' as const) : ('app-report' as const),
      }
      const snapshot = Rpc.applyChanges(empty(), { forkHalt: original }, null, key)
      expect(() => Rpc.applyChanges(snapshot, { forkHalt: replacement }, null, key)).toThrow()
      const store = Memory.createMemoryControlStore(key)
      await store.apply({ forkHalt: original }, 'original')
      await expect(store.apply({ forkHalt: replacement }, 'replacement')).rejects.toThrow()
      expect((await store.load()).forkHalt).toEqual(original)
      expect(await store.lastMutation()).toBe('original')
    },
  )

  test('app clear requests require provider authority even for app-owned event IDs', () => {
    const snapshot = Rpc.applyChanges(
      empty(),
      { forkHalt: { ...halt(), producer: 'app-report' } },
      null,
      key,
    )
    const before = structuredClone(snapshot)
    expect(() =>
      Rpc.applyChanges(
        snapshot,
        { clearAppHold: { eventID: halt().eventID, reportMutationID: 'report' } },
        null,
        key,
      ),
    ).toThrow()
    expect(snapshot).toEqual(before)
  })

  test('stable event IDs', () => {
    expect(Rpc.forkEventID(key)).toBe('["group:fork","g",2]')
    expect(Rpc.recoveryUnavailableEventID(key)).toBe('["group:recovery-unavailable","g",2]')
    expect(Rpc.forkEventID({ groupID: 'g"\\', incarnation: 3 })).toBe('["group:fork","g\\"\\\\",3]')
  })

  test.each([
    ['RPC', Rpc.controlSafetyHeld],
    ['independent memory reducer', Memory.controlSafetyHeld],
  ] as const)('safety fields start null and project field-only holds through %s', (_name, held) => {
    const snapshot = empty()
    expect(held(snapshot)).toBeNull()
    expect(held({ ...snapshot, strand: { reason: 'lost-state' } })).toBeNull()
    expect(
      held({
        ...snapshot,
        controlHold: { reason: 'unsupported-version', position: null },
      }),
    ).toBeNull()
    const recovery = Rpc.applyChanges(snapshot, { recoveryUnavailable: unavailable() }, null, key)
    expect(held(recovery)).toBe('recovery-unavailable')
    const fork = Rpc.applyChanges(snapshot, { forkHalt: halt() }, null, key)
    expect(held(fork)).toBe('fork-halted')
    const both = Rpc.applyChanges(recovery, { forkHalt: halt() }, null, key)
    expect(held(both)).toBe('fork-halted')
    expect(both.strand).toBeNull()
    expect(both.controlHold).toBeNull()
  })

  test.each([undefined, null, { groupID: 'other', incarnation: 2 }, { ...key, incarnation: 3 }])(
    'safety identity requires the matching key %j, including identical reapply',
    (wrongKey) => {
      const snapshot = empty()
      for (const changes of [{ forkHalt: halt() }, { recoveryUnavailable: unavailable() }]) {
        expect(() => Rpc.applyChanges(snapshot, changes, null, wrongKey)).toThrow(TypeError)
        const set = Rpc.applyChanges(snapshot, changes, null, key)
        const before = structuredClone(set)
        expect(() => Rpc.applyChanges(set, changes, null, wrongKey)).toThrow(TypeError)
        expect(set).toEqual(before)
      }
    },
  )

  test.each(['forkHalt', 'recoveryUnavailable'] as const)(
    'inherited %s changes still require a key',
    (field) => {
      const changes: Rpc.ControlChanges = Object.create({
        [field]: field === 'forkHalt' ? halt() : unavailable(),
      })
      const snapshot = empty()
      const before = structuredClone(snapshot)
      expect(() => Rpc.applyChanges(snapshot, changes)).toThrow(TypeError)
      expect(snapshot).toEqual(before)
    },
  )

  test.each(['forkHalt', 'recoveryUnavailable'] as const)(
    'untyped %s clearing rejects atomically even before the first write',
    (field) => {
      const snapshot = empty()
      const changes = {
        [field]: null,
        putOutcomes: [{ id: 'bad', opID: null, at: 1, kind: 'lost' }],
      }
      const before = structuredClone(snapshot)
      expect(() =>
        Rpc.applyChanges(snapshot, changes as unknown as Rpc.ControlChanges, null, key),
      ).toThrow(expect.objectContaining({ name: 'ControlSafetyImmutableError', field }))
      expect(snapshot).toEqual(before)
    },
  )

  test('safety values are defensive and identical writes retain their complete body', () => {
    const input = halt()
    const expected = structuredClone(input)
    const snapshot = Rpc.applyChanges(empty(), { forkHalt: input }, null, key)
    if (input.evidence.kind !== 'epoch-authenticator') throw new Error('Missing authenticator')
    input.evidence.local.fill(9)
    expect(snapshot.forkHalt).toEqual(expected)
    const copy = Rpc.applyChanges(snapshot, { forkHalt: expected }, null, key)
    if (copy.forkHalt?.evidence.kind !== 'epoch-authenticator')
      throw new Error('Missing authenticator')
    copy.forkHalt.evidence.remote.fill(8)
    expect(snapshot.forkHalt).toEqual(expected)
    expect(Rpc.applyChanges(snapshot, {}).forkHalt).toEqual(expected)
  })

  test.each(['forkHalt', 'recoveryUnavailable'] as const)(
    'reads the supplied %s getter once and projects the validated body',
    (field) => {
      let reads = 0
      const expected = field === 'forkHalt' ? halt() : unavailable()
      const changes = Object.defineProperty({}, field, {
        get: () => (++reads === 1 ? expected : null),
      })
      const snapshot = Rpc.applyChanges(empty(), changes, null, key)
      expect(reads).toBe(1)
      expect(snapshot[field]).toEqual(expected)
      expect(Rpc.applyChanges(snapshot, { [field]: expected }, null, key)).toEqual(snapshot)
    },
  )

  test.each(['inherited', 'accessor', 'extra'] as const)(
    'materializes only known safety fields from %s bodies',
    (shape) => {
      const expected = { forkHalt: halt(), recoveryUnavailable: unavailable() }
      const materialize = <TValue extends object>(value: TValue): TValue => {
        if (shape === 'inherited') return Object.create(value) as TValue
        if (shape === 'extra') return { ...value, unknown: 'discard' }
        const body = {}
        for (const [name, child] of Object.entries(value)) {
          let reads = 0
          Object.defineProperty(body, name, {
            get: () => (++reads === 1 ? child : undefined),
          })
        }
        return body as TValue
      }
      const changes = {
        forkHalt: materialize({
          ...expected.forkHalt,
          evidence: materialize(expected.forkHalt.evidence),
        }),
        recoveryUnavailable: materialize(expected.recoveryUnavailable),
      }
      const snapshot = Rpc.applyChanges(empty(), changes, null, key)
      expect(snapshot.forkHalt).toEqual(expected.forkHalt)
      expect(snapshot.recoveryUnavailable).toEqual(expected.recoveryUnavailable)
      expect(Rpc.applyChanges(snapshot, expected, null, key)).toEqual(snapshot)
    },
  )

  test('replacement rejects both-field and ordinary changes atomically', () => {
    const snapshot = Rpc.applyChanges(empty(), { forkHalt: halt() }, null, key)
    const before = structuredClone(snapshot)
    expect(() =>
      Rpc.applyChanges(
        snapshot,
        {
          forkHalt: { ...halt(), detectedAt: 101 },
          recoveryUnavailable: unavailable(),
          putOutcomes: [{ id: 'bad', opID: null, at: 1, kind: 'lost' }],
        },
        null,
        key,
      ),
    ).toThrow(expect.objectContaining({ name: 'ControlSafetyImmutableError', field: 'forkHalt' }))
    expect(snapshot).toEqual(before)
  })
})

type ActualSafety = [
  Rpc.SafetyHold,
  Rpc.GroupForkEvidence,
  Rpc.ForkHalt,
  Rpc.GroupSafetyEvent,
  Rpc.RecoveryUnavailableEvent,
  Rpc.ControlSnapshot,
  Rpc.ControlChanges,
]
type MirroredSafety = [
  Mirror.ConformanceSafetyHold,
  Mirror.ConformanceGroupForkEvidence,
  Mirror.ConformanceForkHalt,
  Mirror.ConformanceGroupSafetyEvent,
  Mirror.ConformanceRecoveryUnavailableEvent,
  Mirror.ConformanceControlSnapshot<Rpc.LogPosition>,
  Mirror.ConformanceControlChanges<Rpc.LogPosition>,
]
function assignSafety(actual: ActualSafety, mirror: MirroredSafety): void {
  const mirrored: MirroredSafety = actual
  const implementation: ActualSafety = mirror
  void mirrored
  void implementation
  // @ts-expect-error Safety fields cannot be cleared through the typed port.
  const clear: Rpc.ControlChanges = { forkHalt: null }
  // @ts-expect-error Safety fields cannot be cleared through the typed mirror.
  const clearMirror: Mirror.ConformanceControlChanges = { recoveryUnavailable: null }
  void clear
  void clearMirror
}
void assignSafety
