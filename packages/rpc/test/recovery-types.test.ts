import { Buffer } from 'node:buffer'
import { describe, expect, expectTypeOf, test } from 'vitest'

import type {
  ConformanceAcceptedRejoinSettlement,
  ConformanceCapturedRejoinRecord,
  ConformanceControlChanges,
  ConformanceControlSnapshot,
  ConformanceLegacyRejoinRecord,
  ConformanceRecoverySource,
  ConformanceRecoveryTargetCapture,
  ConformanceResyncProof,
  ConformanceStoredRejoinRecord,
} from '../../rpc-conformance/src/control-store.js'
import type {
  ConformanceCapturedRecoveryPort,
  ConformanceConfirmedRecoveryHandoff,
  ConformanceGroupMLS,
  ConformanceRecoveryCompletion,
  ConformanceRecoveryContinuation,
  ConformanceRecoveryContinuationPort,
  ConformanceRecoveryReconciliation,
} from '../../rpc-conformance/src/group-mls.js'
import type {
  ControlChanges,
  ControlSnapshot,
  LegacyRejoinRecord,
  RejoinRecord,
} from '../src/control/types.js'
import type { GroupMLS } from '../src/crypto.js'
import { asLogPosition, type LogPosition } from '../src/cursor.js'
import {
  type AcceptedRejoinSettlement,
  assignRecoverySwitchMutationID,
  type CapturedRecoveryPort,
  type CapturedRejoinRecord,
  type ConfirmedRecoveryHandoff,
  copyRecoveryOrigin,
  copyRecoverySource,
  copyRecoveryTargetCapture,
  type RecoveryCompletion,
  type RecoveryContinuation,
  type RecoveryContinuationPort,
  type RecoveryReconciliation,
  type RecoverySource,
  type RecoveryTargetCapture,
  type ResyncProof,
  raiseRecoveryEpochFloor,
  type StoredRejoinRecord,
  validateCaptureHead,
} from '../src/index.js'

const target = (): RecoveryTargetCapture => ({
  targetID: 'recovery-target',
  topicID: 'commit-topic',
  groupInfoEpoch: 7,
  groupInfoAuthenticator: new Uint8Array([1, 2]),
  captureHead: asLogPosition('opaque-head'),
})

function mutual<_TLeft extends TRight, TRight>() {}

test('portable contracts and independent mirrors remain mutually assignable', () => {
  mutual<GroupMLS, ConformanceGroupMLS<LogPosition>>()
  mutual<ConformanceGroupMLS<LogPosition>, GroupMLS>()
  mutual<RecoverySource, ConformanceRecoverySource>()
  mutual<ConformanceRecoverySource, RecoverySource>()
  mutual<RecoveryTargetCapture, ConformanceRecoveryTargetCapture<LogPosition>>()
  mutual<ConformanceRecoveryTargetCapture<LogPosition>, RecoveryTargetCapture>()
  mutual<ResyncProof, ConformanceResyncProof<LogPosition>>()
  mutual<ConformanceResyncProof<LogPosition>, ResyncProof>()
  mutual<CapturedRejoinRecord, ConformanceCapturedRejoinRecord<LogPosition>>()
  mutual<ConformanceCapturedRejoinRecord<LogPosition>, CapturedRejoinRecord>()
  mutual<StoredRejoinRecord, ConformanceStoredRejoinRecord<LogPosition>>()
  mutual<ConformanceStoredRejoinRecord<LogPosition>, StoredRejoinRecord>()
  mutual<AcceptedRejoinSettlement, ConformanceAcceptedRejoinSettlement<LogPosition>>()
  mutual<ConformanceAcceptedRejoinSettlement<LogPosition>, AcceptedRejoinSettlement>()
  mutual<ControlSnapshot, ConformanceControlSnapshot<LogPosition>>()
  mutual<ConformanceControlSnapshot<LogPosition>, ControlSnapshot>()
  mutual<ControlChanges, ConformanceControlChanges<LogPosition>>()
  mutual<ConformanceControlChanges<LogPosition>, ControlChanges>()
  mutual<CapturedRecoveryPort, ConformanceCapturedRecoveryPort<LogPosition>>()
  mutual<ConformanceCapturedRecoveryPort<LogPosition>, CapturedRecoveryPort>()
  mutual<RecoveryReconciliation, ConformanceRecoveryReconciliation<LogPosition>>()
  mutual<ConformanceRecoveryReconciliation<LogPosition>, RecoveryReconciliation>()
  mutual<ConfirmedRecoveryHandoff, ConformanceConfirmedRecoveryHandoff<LogPosition>>()
  mutual<ConformanceConfirmedRecoveryHandoff<LogPosition>, ConfirmedRecoveryHandoff>()
  mutual<RecoveryContinuation, ConformanceRecoveryContinuation<LogPosition>>()
  mutual<ConformanceRecoveryContinuation<LogPosition>, RecoveryContinuation>()
  mutual<RecoveryCompletion, ConformanceRecoveryCompletion>()
  mutual<ConformanceRecoveryCompletion, RecoveryCompletion>()
  mutual<RecoveryContinuationPort, ConformanceRecoveryContinuationPort<LogPosition>>()
  mutual<ConformanceRecoveryContinuationPort<LogPosition>, RecoveryContinuationPort>()
  expectTypeOf<RejoinRecord>().toEqualTypeOf<LegacyRejoinRecord>()
  expectTypeOf<RejoinRecord>().toEqualTypeOf<ConformanceLegacyRejoinRecord<LogPosition>>()
  expectTypeOf<RecoverySource['trust']>().toEqualTypeOf<unknown>()
  expectTypeOf<RecoverySource<{ publicKey: Uint8Array }>>().toEqualTypeOf<
    ConformanceRecoverySource<{ publicKey: Uint8Array }>
  >()
  expectTypeOf<ResyncProof['position']>().toEqualTypeOf<LogPosition>()
  expectTypeOf<Extract<StoredRejoinRecord, { format: 2 }>>().toEqualTypeOf<CapturedRejoinRecord>()
  expectTypeOf<
    Extract<
      keyof AcceptedRejoinSettlement,
      'request' | 'requestKey' | 'candidate' | 'payload' | 'trust'
    >
  >().toEqualTypeOf<never>()
})

describe('capture head validation', () => {
  test.each([null, 'opaque', 'lower-head', 'x'.repeat(64), '😀'.repeat(32)])(
    'accepts %s unchanged',
    (head) => {
      expect(validateCaptureHead(head)).toBe(head)
    },
  )
  test.each([undefined, '', 'x'.repeat(65), '😀'.repeat(33), 3, false, {}, []])(
    'refuses %s',
    (head) => {
      expect(() => validateCaptureHead(head)).toThrow(TypeError)
    },
  )
})

test('source copying isolates nested opaque trust and both identity projections', () => {
  const key = { groupID: 'source', incarnation: 1 }
  const authenticator = new Uint8Array([3, 4])
  const trust = {
    installed: { ...key, epoch: 6, authenticator },
    ledger: ['owed'],
    devices: new Map([['device', { bytes: new Uint8Array([5]), lifetime: 9n }]]),
  }
  const source: RecoverySource<typeof trust> = {
    key,
    stateVersion: 2,
    identity: trust.installed,
    trust,
    trustDigest: 'public-trust-digest',
    lifetimeRevision: 3,
  }
  const saved = copyRecoverySource(source)
  key.groupID = 'changed'
  authenticator.fill(0)
  trust.ledger.push('injected')
  trust.devices.get('device')?.bytes.fill(0)
  trust.devices.clear()
  expect(saved.key).toEqual({ groupID: 'source', incarnation: 1 })
  expect(saved.identity?.authenticator).toEqual(new Uint8Array([3, 4]))
  expect(saved.trust.ledger).toEqual(['owed'])
  expect(saved.trust.devices.get('device')).toEqual({ bytes: new Uint8Array([5]), lifetime: 9n })
  saved.identity?.authenticator.fill(9)
  expect(saved.trust.installed.authenticator).toEqual(new Uint8Array([3, 4]))
  expect(saved.trustDigest).toBe('public-trust-digest')
  expect(copyRecoverySource({ ...source, identity: null }).identity).toBeNull()
  expect(copyRecoverySource({ ...source, trust: 'opaque' }).trust).toBe('opaque')
})

test('target and public origin copies preserve original capture and search facts', () => {
  const capture = target()
  const origin = {
    sourceKey: { groupID: 'source', incarnation: 1 },
    target: capture,
    searchFrom: asLogPosition('search-origin'),
  }
  const savedTarget = copyRecoveryTargetCapture(capture)
  const savedOrigin = copyRecoveryOrigin(origin)
  origin.sourceKey.incarnation = 2
  origin.searchFrom = asLogPosition('other')
  capture.captureHead = null
  capture.groupInfoAuthenticator.fill(0)
  capture.targetID = 'other'
  expect(savedTarget).toEqual(target())
  expect(savedOrigin).toEqual({
    sourceKey: { groupID: 'source', incarnation: 1 },
    target: target(),
    searchFrom: 'search-origin',
  })
  savedTarget.groupInfoAuthenticator.fill(7)
  expect(savedOrigin.target.groupInfoAuthenticator).toEqual(new Uint8Array([1, 2]))
})

test.each(['input', 'copy'] as const)(
  'source copying isolates Buffer authenticators from %s mutation',
  (mutated) => {
    const authenticator = Buffer.from([3, 4])
    const source: RecoverySource = {
      key: { groupID: 'source', incarnation: 1 },
      stateVersion: 2,
      identity: { groupID: 'source', incarnation: 1, epoch: 6, authenticator },
      trust: null,
      trustDigest: 'public-trust-digest',
      lifetimeRevision: 3,
    }
    const saved = copyRecoverySource(source)
    if (mutated === 'input') {
      authenticator.fill(0)
      expect(saved.identity?.authenticator).toEqual(new Uint8Array([3, 4]))
    } else {
      saved.identity?.authenticator.fill(9)
      expect(authenticator).toEqual(Buffer.from([3, 4]))
    }
  },
)

describe.each(['target', 'origin'] as const)('%s copying with Buffer authenticators', (kind) => {
  test.each(['input', 'copy'] as const)('isolates authenticator from %s mutation', (mutated) => {
    const authenticator = Buffer.from([1, 2])
    const capture = { ...target(), groupInfoAuthenticator: authenticator }
    const saved =
      kind === 'target'
        ? copyRecoveryTargetCapture(capture)
        : copyRecoveryOrigin({
            sourceKey: { groupID: 'source', incarnation: 1 },
            target: capture,
            searchFrom: asLogPosition('search-origin'),
          }).target
    if (mutated === 'input') {
      authenticator.fill(0)
      expect(saved.groupInfoAuthenticator).toEqual(new Uint8Array([1, 2]))
    } else {
      saved.groupInfoAuthenticator.fill(9)
      expect(authenticator).toEqual(Buffer.from([1, 2]))
    }
  })
})

test('switch mutation ID assignment is idempotent and refuses replacement', () => {
  expect(assignRecoverySwitchMutationID(null, 'switch-A')).toBe('switch-A')
  expect(assignRecoverySwitchMutationID('switch-A', 'switch-A')).toBe('switch-A')
  expect(() => assignRecoverySwitchMutationID('switch-A', 'switch-B')).toThrow()
})

test.each([
  [null, 7, 7],
  [7, 6, 7],
  [7, 7, 7],
  [7, 9, 9],
  [0, 0, 0],
] as const)('floor %s raised to %s preserves %s', (current, epoch, expected) => {
  expect(raiseRecoveryEpochFloor(current, epoch)).toBe(expected)
})

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
  'invalid epoch %s refuses without lowering a floor',
  (epoch) => {
    expect(() => raiseRecoveryEpochFloor(7, epoch)).toThrow(TypeError)
    expect(() => raiseRecoveryEpochFloor(epoch, 7)).toThrow(TypeError)
  },
)

test('public origin copying retains only public capture and key fields', () => {
  const origin = {
    sourceKey: { groupID: 'source', incarnation: 1, requestKey: new Uint8Array([9]) },
    target: { ...target(), candidate: new Uint8Array([8]) },
    searchFrom: null,
  }
  expect(copyRecoveryOrigin(origin)).toEqual({
    sourceKey: { groupID: 'source', incarnation: 1 },
    target: target(),
    searchFrom: null,
  })
})
