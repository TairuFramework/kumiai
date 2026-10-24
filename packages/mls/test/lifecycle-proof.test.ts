import {
  authorityPath,
  type ControllerLog,
  canonicalBytes,
  createRemove,
  createReset,
  createRevoke,
  createRotate,
  deriveKeyMaterial,
  digestOf,
  epochHeads,
  type SignedEvent,
  snapshotOf,
} from '@kokuin/controller'
import { createIdentity, normalizeDID } from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64U } from '@sozai/codec'
import { beforeAll, describe, expect, test, vi } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import { readCapability } from '../src/capability.js'
import { asControllerLog, foldChain, foldControllerLog } from '../src/controller-log.js'
import { foldEnvelope } from '../src/envelope-fold.js'
import { LeafBindingError, RevokeProofError } from '../src/errors.js'
import { restoreGroup } from '../src/group-create.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup } from '../src/group-handle.js'
import type { VerifiedLedgerEntry } from '../src/ledger.js'
import { signLedgerEntry } from '../src/ledger.js'
import { authenticateLifecycleProof, verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { effectOf } from '../src/member-root.js'
import * as registryModule from '../src/registry.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue, registrySeed, revocationOf } from '../src/registry.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import {
  denyEffects,
  revokeChain,
  rotateChain,
  snapshotForChain,
} from './fixtures/controller-chain.js'
import { buildEpoch, saturatedLog } from './fixtures/controller-epoch.js'
import {
  addMember,
  agent,
  bindingFor,
  controllerID,
  controllerSeed,
  enact,
  inception,
  lifecycleGroup,
  publish,
  rawEnact,
  trustedGrant,
} from './fixtures/lifecycle-ledger.js'
import { rawAdd, withoutHolderEvidence } from './fixtures/lifecycle-pipeline.js'

/** Add a chained leaf without its holder's evidence, below the acceptance gate. */
async function addUnevidenced(
  group: Parameters<typeof rawAdd>[0],
  identity: Parameters<typeof rawAdd>[1],
  binding: Parameters<typeof withoutHolderEvidence>[0],
) {
  const added = await rawAdd(group, identity, withoutHolderEvidence(binding))
  return { group: deriveGroup(group, added.result.newState) }
}

const target = agent(61).id
const otherTarget = agent(71).id

function chainRevoke(crit: boolean): SignedEvent {
  return {
    event: {
      t: 'rev',
      crit,
      g: 0,
      s: 1,
      p: digestOf(inception.event),
      i: controllerID,
      v: 1,
      x: target,
    },
    sigs: [],
  } as unknown as SignedEvent
}

function revoke(log: Array<SignedEvent>, subject: string): SignedEvent {
  return revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain: log, subject })
}

function proofEntry(
  issuer: string,
  subject: string,
  value: DeviceValue,
): VerifiedLedgerEntry<DeviceValue> {
  return {
    issuer,
    entry: {
      type: DEVICE_ENTRY_TYPE,
      groupID: 'lifecycle-ledger',
      subject: value.proof == null ? subject : controllerID,
      value,
    },
  }
}

async function recordFirst() {
  const setup = await lifecycleGroup()
  const log = [inception, revoke([inception], otherTarget)]
  const verified = proofEntry(setup.identity.id, otherTarget, {
    effects: denyEffects(log.slice(1), otherTarget),
    removed: [],
    op: 'revoke',
    proof: asControllerLog(log.slice(1)),
    revoked: [{ did: otherTarget }],
  })
  const token = await signLedgerEntry(setup.identity, verified.entry)
  const { group } = await enact(setup.group, [token])
  return { ...setup, group, log }
}

describe('lifecycle envelope authority', () => {
  test.each(['register', 'add', 'label', 'revoke'] as const)('rejects unproven %s', async (op) => {
    const { group, identity } = await lifecycleGroup()
    const verified = proofEntry(identity.id, target, {
      op,
      controller: controllerID,
      capability: 'manage',
    })
    expect(
      foldEnvelope({
        baseRoster: group.roster,
        baseRegistry: group.registry,
        entries: [{ verified, entryID: 'entry' }],
        groupID: group.groupID,
        context: {
          controllerID,
          memberController: (did) => group.bindingOfDID(did)?.controller,
        },
      }).ok,
    ).toBe(false)
  })

  test.each([ROLE_ENTRY_TYPE, 'kumiai.future'])('rejects reserved type %s', async (type) => {
    const { group, identity } = await lifecycleGroup()
    const verified = {
      issuer: identity.id,
      entry: { type, groupID: group.groupID, subject: target, value: 'admin' },
    }
    expect(
      foldEnvelope({
        baseRoster: group.roster,
        baseRegistry: group.registry,
        entries: [{ verified, entryID: 'entry' }],
        groupID: group.groupID,
        context: {
          controllerID,
          memberController: (did) => group.bindingOfDID(did)?.controller,
        },
      }).ok,
    ).toBe(false)
  })

  test('uses current membership instead of a registry binding or signed controller issuer', async () => {
    const { group, identity } = await lifecycleGroup()
    for (const [issuer, expected] of [
      [identity.id, true],
      [target, false],
      [controllerID, false],
    ] as const) {
      const verified = {
        issuer,
        entry: { type: 'consumer.event', groupID: group.groupID, subject: target, value: 1 },
      }
      const result = foldEnvelope({
        baseRoster: group.roster,
        baseRegistry: group.registry,
        entries: [{ verified, entryID: 'entry' }],
        groupID: group.groupID,
        context: {
          controllerID,
          memberController: (did) => group.bindingOfDID(did)?.controller,
        },
      })
      expect(result.ok).toBe(expected)
    }
  })
})

describe('authenticated proof attachment', () => {
  test('accepts a leafless revocation and returns its floor and deny effects', async () => {
    const { group, identity } = await lifecycleGroup()
    const log = [inception, revoke([inception], target)]
    const effects = await verifyLifecycleProof(
      group,
      proofEntry(identity.id, target, {
        effects: denyEffects(log.slice(1), target),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(log.slice(1)),
        revoked: [{ did: target }],
      }),
    )
    expect(effects).toMatchObject({
      controller: controllerID,
      recordedLog: { chain: log, events: [] },
      genFloor: 0,
      timeFloor: 0,
      revoked: [{ did: target }],
      removed: [],
      removeLeafIndices: [],
    })
    expect(group.registry.devices.size).toBe(0)
  })

  test('requires a revocation event for the subject', async () => {
    const { group, identity } = await lifecycleGroup()
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects([], target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'no-rev' })
  })

  test('rejects a proof for the wrong controller', async () => {
    const { group, identity } = await lifecycleGroup()
    const foreign = structuredClone(inception)
    foreign.event.i = 'did:kokuin:foreign'
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects([foreign], target),
          removed: [],
          op: 'revoke',
          controller: 'did:kokuin:foreign',
          proof: asControllerLog([foreign]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'wrong-controller' })
  })

  test.each(['capability', 'signature', 'skip'] as const)(
    'rejects unauthenticated %s evidence',
    async (kind) => {
      const { group, identity } = await lifecycleGroup()
      const rev = revoke([inception], target)
      let proof: Array<SignedEvent> = [inception, rev]
      if (kind === 'capability') {
        proof = [
          inception,
          { ...rev, event: { ...rev.event, cap: 'delegated-management' } } as SignedEvent,
        ]
      } else if (kind === 'signature') {
        proof = [inception, { ...rev, sigs: [] }]
      } else {
        const unknown = {
          ...rev,
          event: { ...rev.event, t: 'future', crit: false },
          sigs: [],
        } as unknown as SignedEvent
        proof = [inception, unknown, rev]
        expect(foldChain(controllerID, proof).ok).toBe(true)
      }
      await expect(
        verifyLifecycleProof(
          group,
          proofEntry(identity.id, target, {
            effects: denyEffects(proof.slice(1), target),
            removed: [],
            op: 'revoke',
            proof: asControllerLog(proof.slice(1)),
            revoked: [{ did: target }],
          }),
        ),
      ).rejects.toMatchObject({ reason: 'not-authority-signed' })
    },
  )

  test('rejects detached suffixes', async () => {
    const { group, identity } = await recordFirst()
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects([revoke([inception], target)], target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([revoke([inception], target)]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'detached' })
  })

  test('requires a reset entry before a suffix can advance generation', async () => {
    const { group, identity } = await recordFirst()
    const reset = createReset(controllerSeed, 0, 1)
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects([reset, revoke([inception, reset], target)], target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([reset, revoke([inception, reset], target)]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'needs-reset' })
  })

  test('compares the declared effects with the tree-derived effects', async () => {
    const { group, identity } = await lifecycleGroup()
    const proof = [inception, revoke([inception], target)]
    for (const revoked of [[], [{ did: otherTarget }], [{ did: target }, { did: target }]]) {
      await expect(
        verifyLifecycleProof(
          group,
          proofEntry(identity.id, target, {
            effects: denyEffects(proof.slice(1), target),
            removed: [],
            op: 'revoke',
            proof: asControllerLog(proof.slice(1)),
            revoked,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'effects-mismatch' })
    }
  })

  test('rejects proof growth beyond the history horizon', async () => {
    const { group, identity } = await lifecycleGroup()
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      snapshot: snapshotForChain(controllerID, [inception]),
      seal: '界'.repeat(131072),
    })
    const proof = [inception, rotation, revoke([inception, rotation], target)]
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects(proof.slice(1), target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog(proof.slice(1)),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'too-large' })
  })

  test('a seeded group requires reset before a re-parented revoke', async () => {
    const { group, identity } = await lifecycleGroup()
    const reset = createReset(controllerSeed, 0, 1)
    const log = [inception, reset, revoke([inception, reset], target)]
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects(log.slice(1), target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog(log.slice(1)),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'needs-reset' })
  })

  test('allows a first revoke re-parented on a recorded reset', async () => {
    const reset = createReset(controllerSeed, 0, 1)
    const prefix = [inception, reset]
    const { group, identity } = await lifecycleGroup(prefix, asControllerLog(prefix))
    const rev = revoke(prefix, target)
    const effects = await verifyLifecycleProof(
      group,
      proofEntry(identity.id, target, {
        effects: denyEffects([rev], target),
        removed: [],
        op: 'revoke',
        proof: asControllerLog([rev]),
        revoked: [{ did: target }],
      }),
    )
    expect(effects).toEqual({
      controller: controllerID,
      recordedLog: { chain: [...prefix, rev], events: [] },
      genFloor: 1,
      timeFloor: 0,
      revoked: [{ did: target }],
      removed: [],
      removeLeafIndices: [],
    })
  })
})

describe('recorded log replay', () => {
  describe('long signed suffix', () => {
    const firstLog = [inception, revoke([inception], otherTarget)]
    let log: Array<SignedEvent>

    // Signing the fixture is independent of the replay behaviour under test.
    beforeAll(() => {
      log = [...firstLog]
      for (let index = 0; index < 50; index++) {
        const prior = log.at(-1)
        if (prior == null) throw new Error('Missing rotation head')
        log.push(rotateChain({ seed: controllerSeed, profile: 0, did: controllerID, chain: log }))
      }
      log.push(revoke(log, target))
    })

    test.each(['receive', 'derivation', 'restore', 'Welcome'] as const)(
      'appends a 51-event suffix identically on %s',
      async (path) => {
        const initial = await lifecycleGroup()
        const second = agent(51)
        const members = await addMember(initial.group, second, await bindingFor(second))
        const firstToken = await signLedgerEntry(
          initial.identity,
          proofEntry(initial.identity.id, otherTarget, {
            effects: denyEffects(firstLog.slice(1), otherTarget),
            removed: [],
            op: 'revoke',
            proof: asControllerLog(firstLog.slice(1)),
            revoked: [{ did: otherTarget }],
          }).entry,
        )
        const first = await enact(members.group, [firstToken])
        publish(initial.tokens, [firstToken])
        await members.joined.processMessage(first.message)
        const proofSuffix = log.slice(2)
        expect(proofSuffix).toHaveLength(51)
        const secondToken = await signLedgerEntry(
          initial.identity,
          proofEntry(initial.identity.id, target, {
            effects: denyEffects(proofSuffix, target),
            removed: [],
            op: 'revoke',
            proof: asControllerLog(proofSuffix),
            revoked: [{ did: target }],
          }).entry,
        )
        const live = await enact(first.group, [secondToken])
        publish(initial.tokens, [secondToken])
        expect(live.group.registry.controllers.get(controllerID)?.recordedLog).toEqual({
          chain: log,
          events: [],
        })
        expect(revocationOf(live.group, target)).toEqual({
          controller: controllerID,
          proofRef: { chainIndex: 52 },
        })
        if (path === 'receive') {
          await members.joined.processMessage(live.message)
          expect(members.joined.registry).toEqual(live.group.registry)
        } else if (path === 'derivation') {
          expect(deriveGroup(live.group, live.group.state).registry).toEqual(live.group.registry)
        } else if (path === 'restore') {
          const restored = await restoreGroup({
            state: live.group.state,
            credential: live.group.credential,
            ledgerEntries: live.group.ledgerTokens,
          })
          expect(restored.registry).toEqual(live.group.registry)
        } else {
          const newcomer = agent(81)
          const welcome = await addMember(live.group, newcomer, await bindingFor(newcomer))
          expect(welcome.joined.registry).toEqual(live.group.registry)
          expect(welcome.joined.currentDenySet()).toEqual(new Set([otherTarget, target]))
        }
        expect(first.group.registry.devices.has(target)).toBe(false)
      },
    )
  })

  test('an attached suffix proves the next denial', async () => {
    const { group, identity } = await lifecycleGroup()
    const log = [inception, revoke([inception], otherTarget)]
    log.push(revoke(log, target))
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, otherTarget, {
        effects: denyEffects(log.slice(1, 2), otherTarget),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(log.slice(1, 2)),
        revoked: [{ did: otherTarget }],
      }).entry,
    )
    const recorded = await enact(group, [token])
    const effects = await verifyLifecycleProof(
      recorded.group,
      proofEntry(identity.id, target, {
        effects: denyEffects(log.slice(2), target),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(log.slice(2)),
        revoked: [{ did: target }],
      }),
    )
    expect(effects.recordedLog).toEqual({ chain: log, events: [] })
    expect(effects.recordedLog.chain).toHaveLength(3)
  })

  test('un-revoke and ordinary rotation preserve the permanent ledger deny set', async () => {
    const { group, identity, log } = await recordFirst()
    const prior = log.at(-1)
    if (prior == null) throw new Error('Missing controller head')
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: prior.event,
      snapshot: { ...snapshotForChain(controllerID, log), deny: [] },
    })
    const nextLog = [...log, rotation]
    nextLog.push(revoke(nextLog, target))
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, target, {
        effects: denyEffects(nextLog.slice(2), target),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(nextLog.slice(2)),
        revoked: [{ did: target }],
      }).entry,
    )
    const next = await enact(group, [token])
    expect(next.group.registry.devices.get(otherTarget)?.status).toBe('revoked')
    expect(next.group.currentDenySet().has(normalizeDID(otherTarget))).toBe(true)
    expect(revocationOf(next.group, otherTarget)).toEqual({
      controller: controllerID,
      proofRef: { chainIndex: 1 },
    })
    expect(next.group.registry.controllers.get(controllerID)?.genFloor).toBe(0)
    const binding = group.bindingOfDID(identity.id)
    if (binding?.capability == null) throw new Error('Missing leaf capability')
    expect(readCapability(binding.capability).payload.iss).toBe(controllerID)
  })
})

describe('live effect derivation', () => {
  test('revoking a trusted issuer includes unevidenced children and their exact pre-commit leaf indices', async () => {
    const initial = await lifecycleGroup()
    const trusted = agent(51)
    const withTrusted = await addMember(initial.group, trusted, await bindingFor(trusted))
    const child = agent(61)
    const binding = await bindingFor(child, [inception], {
      identity: trusted,
      parent: await trustedGrant(trusted),
    })
    const withChild = await addUnevidenced(withTrusted.group, child, binding)
    const revoked = [{ did: trusted.id }, { did: child.id, cascadedFrom: trusted.id }]
    const verified = proofEntry(initial.identity.id, trusted.id, {
      effects: denyEffects([revoke([inception], trusted.id)], trusted.id),
      removed: [],
      op: 'revoke',
      proof: asControllerLog([revoke([inception], trusted.id)]),
      revoked,
    })
    const effects = await verifyLifecycleProof(withChild.group, verified)
    expect(effects.revoked).toEqual(revoked)
    expect(effects.removeLeafIndices).toEqual([1, 2])
    await expect(
      verifyLifecycleProof(withChild.group, {
        ...verified,
        entry: {
          ...verified.entry,
          value: { ...verified.entry.value, revoked: [{ did: trusted.id }] },
        },
      }),
    ).rejects.toMatchObject({ reason: 'effects-mismatch' })
  })

  test('reset replaces the recorded chain, raises floors and survives replay without its old tree', async () => {
    const { group, identity } = await recordFirst()
    const reset = createReset(controllerSeed, 0, 1)
    const verified = proofEntry(identity.id, controllerID, {
      effects: [],
      removed: [],
      op: 'reset',
      proof: asControllerLog([inception, reset]),
      revoked: [{ did: identity.id }],
    })
    const effects = await verifyLifecycleProof(group, verified)
    expect(effects.removeLeafIndices).toEqual([0])
    expect(effects.genFloor).toBe(1)
    const token = await signLedgerEntry(identity, verified.entry)
    // Replay intentionally uses a later tree; acceptance used the pre-commit tree above.
    const replay = deriveGroup(group, group.state)
    await replay.applyLedgerEntries([token])
    expect(replay.registry.controllers.get(controllerID)).toMatchObject({
      recordedLog: { chain: [inception, reset], events: [] },
      genFloor: 1,
      timeFloor: 0,
    })
    expect(revocationOf(replay, identity.id)).toEqual({
      controller: controllerID,
      proofRef: { snapshot: 1 },
      reason: 'reset',
    })
    expect(revocationOf(replay, otherTarget)).toEqual({
      controller: controllerID,
      proofRef: { chainIndex: 1 },
    })
    await expect(
      verifyLifecycleProof(
        replay,
        proofEntry(identity.id, target, {
          effects: denyEffects([revoke([inception], target)], target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([revoke([inception], target)]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'generation-floor' })
    const restored = await restoreGroup({
      state: replay.state,
      credential: replay.credential,
      ledgerEntries: replay.ledgerTokens,
    })
    expect(restored.registry).toEqual(replay.registry)
  })

  test('clock raises only to authenticated pre-commit tree time', async () => {
    const { group, identity } = await lifecycleGroup()
    const binding = group.bindingOfDID(identity.id)
    if (binding?.capability == null) throw new Error('Missing leaf capability')
    const time = readCapability(binding.capability).payload.iat
    const effects = await verifyLifecycleProof(
      group,
      proofEntry(identity.id, controllerID, { op: 'clock', time }),
    )
    expect(effects.timeFloor).toBe(time)
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, controllerID, { op: 'clock', time: time + 1 }),
      ),
    ).rejects.toThrow()
  })
})

describe('proof boundary cases', () => {
  test('a throwing ledger apply leaves the handle usable and unchanged', async () => {
    const { group, identity } = await lifecycleGroup()
    const [seed] = structuredClone(group.ledger)
    if (seed == null) throw new Error('Missing seed')
    expect(seed.verified.entry.value).toMatchObject({ op: 'seed' })
    expect(group.ledgerTokens).toEqual([seed.token])
    const clock = await signLedgerEntry(
      identity,
      proofEntry(identity.id, controllerID, { op: 'clock', time: 100 }).entry,
    )
    const registry = group.registry
    const roster = group.roster
    const failure = new Error('Control fold failed')
    const fold = vi.spyOn(registryModule, 'foldControl').mockImplementationOnce(() => {
      throw failure
    })
    try {
      await expect(group.applyLedgerEntries([clock])).rejects.toBe(failure)
    } finally {
      fold.mockRestore()
    }
    expect(group.ledgerTokens).toEqual([seed.token])
    expect(group.ledger).toEqual([seed])
    expect(group.registry).toEqual(registry)
    expect(group.roster).toEqual(roster)
    await expect(group.applyLedgerEntries([])).resolves.toEqual([])
    expect(deriveGroup(group, group.state).registry).toEqual(registry)
    const honest = await enact(group, [clock])
    expect(honest.group.registry.controllers.get(controllerID)?.timeFloor).toBe(100)
  })

  test.each([false, true])(
    'leaf verification refuses unsigned chain revokes with crit=%s',
    async (crit) => {
      const identity = agent(41)
      const binding = await bindingFor(identity)
      const verifying = verifyLeafCredential(
        makeMLSCredential(identity, {
          ...binding,
          prefix: [inception, { ...chainRevoke(crit), sigs: [] }],
        }),
        identity.publicKey,
      )
      await expect(verifying).rejects.toBeInstanceOf(LeafBindingError)
      await expect(verifying).rejects.toMatchObject({ reason: 'controller-mismatch' })
    },
  )

  test('leaf verification refuses a signed non-reset rotate without a snapshot', async () => {
    const identity = agent(41)
    const binding = await bindingFor(identity)
    const rotation = rotateChain({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      chain: [inception],
    })
    const event: SignedEvent['event'] & { m?: unknown; d?: unknown } = { ...rotation.event }
    delete event.m
    delete event.d
    const sigs = [
      toB64U(
        ed25519.sign(
          canonicalBytes(event),
          deriveKeyMaterial(controllerSeed, authorityPath(0, 0, 1), 'EdDSA'),
        ),
      ),
    ]
    const verifying = verifyLeafCredential(
      makeMLSCredential(identity, { ...binding, prefix: [inception, { event, sigs }] }),
      identity.publicKey,
    )
    await expect(verifying).rejects.toBeInstanceOf(LeafBindingError)
    await expect(verifying).rejects.toMatchObject({ reason: 'controller-mismatch' })
  })

  test('an empty first proof has no revocation', async () => {
    const { group, identity } = await lifecycleGroup()
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects([], target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([]),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'no-rev' })
  })

  test('a later full chain cannot substitute for an attached suffix', async () => {
    const { group, identity, log } = await recordFirst()
    const full = [...log, revoke(log, target)]
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          effects: denyEffects(full, target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog(full),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'detached' })
  })

  test('a second reset to the same generation cannot raise its floor', async () => {
    const reset = createReset(controllerSeed, 0, 1)
    const { group, identity } = await lifecycleGroup([inception, reset])
    const entry = proofEntry(identity.id, controllerID, {
      effects: [],
      removed: [],
      op: 'reset',
      proof: asControllerLog([inception, reset]),
      revoked: [],
    })
    const token = await signLedgerEntry(identity, entry.entry)
    const recorded = await enact(group, [token])
    await expect(verifyLifecycleProof(recorded.group, entry)).rejects.toMatchObject({
      reason: 'generation-floor',
    })
  })

  test('an absent issuer cannot publish a valid controller proof', async () => {
    const { group } = await lifecycleGroup()
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(target, otherTarget, {
          effects: denyEffects([revoke([inception], otherTarget)], otherTarget),
          removed: [],
          op: 'revoke',
          proof: asControllerLog([revoke([inception], otherTarget)]),
          revoked: [{ did: otherTarget }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'wrong-controller' })
  })

  test('a shrinking proof remains possible when the pre-commit history exceeds the horizon', async () => {
    const { group, identity } = await lifecycleGroup()
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      snapshot: snapshotForChain(controllerID, [inception]),
      seal: '界'.repeat(131072),
    })
    const device = agent(61)
    const members = await addMember(group, device, await bindingFor(device, [inception, rotation]))
    const effects = await verifyLifecycleProof(
      members.group,
      proofEntry(identity.id, device.id, {
        effects: denyEffects([revoke([inception], device.id)], device.id),
        removed: [],
        op: 'revoke',
        proof: asControllerLog([revoke([inception], device.id)]),
        revoked: [{ did: device.id }],
      }),
    )
    expect(effects.removeLeafIndices).toEqual([1])
  })

  test('rotation preserves a previously issued leaf grant', async () => {
    const { group, identity } = await lifecycleGroup()
    const binding = await bindingFor(identity)
    const rotation = rotateChain({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      chain: [inception],
    })
    await expect(
      verifyLeafCredential(
        makeMLSCredential(identity, {
          ...binding,
          prefix: [inception, rotation],
        }),
        identity.publicKey,
      ),
    ).resolves.toBeUndefined()
    expect(group.registry.devices.size).toBe(0)
  })

  test('reset cascades from an old trusted leaf to an unevidenced child with a newer prefix', async () => {
    const reset = createReset(controllerSeed, 0, 1)
    const current = [inception, reset]
    const { group, identity } = await lifecycleGroup(current)
    const trusted = agent(51)
    const withTrusted = await addMember(group, trusted, await bindingFor(trusted))
    const child = agent(61)
    const withChild = await addUnevidenced(
      withTrusted.group,
      child,
      await bindingFor(child, current, {
        identity: trusted,
        parent: await trustedGrant(trusted, current),
      }),
    )
    const effects = await verifyLifecycleProof(
      withChild.group,
      proofEntry(identity.id, controllerID, {
        effects: [],
        removed: [],
        op: 'reset',
        proof: asControllerLog(current),
        revoked: [{ did: trusted.id }, { did: child.id, cascadedFrom: trusted.id }],
      }),
    )
    expect(effects.genFloor).toBe(1)
    expect(effects.revoked).toEqual([
      { did: trusted.id },
      { did: child.id, cascadedFrom: trusted.id },
    ])
    expect(effects.removeLeafIndices).toEqual([1, 2])
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, controllerID, {
        effects: [],
        removed: [],
        op: 'reset',
        proof: asControllerLog(current),
        revoked: effects.revoked,
      }).entry,
    )
    const replay = deriveGroup(withChild.group, withChild.group.state)
    await replay.applyLedgerEntries([token])
    expect(revocationOf(replay, child.id)).toEqual({
      controller: controllerID,
      proofRef: { snapshot: 1 },
      reason: 'reset',
      cascadedFrom: trusted.id,
    })
  })

  test('reset and clock floors replay identically through restore, derived handles and Welcome', async () => {
    const reset = createReset(controllerSeed, 0, 1)
    const prefix = [inception, reset]
    const { group, identity } = await lifecycleGroup(prefix)
    const resetToken = await signLedgerEntry(
      identity,
      proofEntry(identity.id, controllerID, {
        effects: [],
        removed: [],
        op: 'reset',
        proof: asControllerLog(prefix),
        revoked: [],
      }).entry,
    )
    const resetGroup = await enact(group, [resetToken])
    const binding = resetGroup.group.bindingOfDID(identity.id)
    if (binding?.capability == null) throw new Error('Missing leaf capability')
    const time = readCapability(binding.capability).payload.iat
    const clock = await signLedgerEntry(
      identity,
      proofEntry(identity.id, controllerID, { op: 'clock', time }).entry,
    )
    const live = await enact(resetGroup.group, [clock])
    const restored = await restoreGroup({
      state: live.group.state,
      credential: live.group.credential,
      ledgerEntries: live.group.ledgerTokens,
    })
    const newcomer = agent(81)
    const welcome = await addMember(live.group, newcomer, await bindingFor(newcomer, prefix))
    expect(restored.registry).toEqual(live.group.registry)
    expect(deriveGroup(live.group, live.group.state).registry).toEqual(live.group.registry)
    expect(welcome.joined.registry).toEqual(live.group.registry)
    expect(welcome.joined.registry.controllers.get(controllerID)).toMatchObject({
      genFloor: 1,
      timeFloor: time,
    })
  })
})

describe('lifecycle ledger pipeline', () => {
  test('author and receiver use pre-commit membership for consumer entries', async () => {
    const { group, identity, tokens } = await lifecycleGroup()
    const recipient = agent(51)
    const members = await addMember(group, recipient, await bindingFor(recipient))
    const token = await signLedgerEntry(identity, {
      type: 'consumer.event',
      groupID: group.groupID,
      subject: target,
      value: 'accepted',
    })
    const result = await enact(members.group, [token])
    publish(tokens, [token])
    await members.joined.processMessage(result.message)
    expect(members.joined.ledgerTokens).toEqual([...group.ledgerTokens, token])
    expect(members.joined.registry).toEqual(result.group.registry)
    const absentToken = await signLedgerEntry(agent(61), {
      type: 'consumer.event',
      groupID: group.groupID,
      subject: target,
      value: 'absent issuer',
    })
    await expect(enact(result.group, [absentToken])).rejects.toThrow(/no pre-commit/)
  })

  test('declared effects mismatch rejects before authoring or receiving despite an accepting caller policy', async () => {
    const { group, identity, tokens } = await lifecycleGroup()
    const recipient = agent(51)
    const members = await addMember(group, recipient, await bindingFor(recipient))
    const [seed] = structuredClone(members.joined.ledger)
    if (seed == null) throw new Error('Missing seed')
    expect(seed.verified.entry.value).toMatchObject({ op: 'seed' })
    expect(members.joined.ledgerTokens).toEqual([seed.token])
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, target, {
        effects: denyEffects([revoke([inception], target)], target),
        removed: [],
        op: 'revoke',
        proof: asControllerLog([revoke([inception], target)]),
        revoked: [{ did: otherTarget }],
      }).entry,
    )
    await expect(enact(members.group, [token])).rejects.toMatchObject({
      reason: 'effects-mismatch',
    })
    publish(tokens, [token])
    const message = await rawEnact(members.group, [token])
    const epoch = members.joined.epoch
    const before = members.joined.registry
    await expect(members.joined.processMessage(message)).rejects.toThrow()
    expect(members.joined.epoch).toBe(epoch)
    expect(members.joined.registry).toBe(before)
    expect(members.joined.ledgerTokens).toEqual([seed.token])
    expect(members.joined.ledger).toEqual([seed])
  })

  test('the receiver rejects a lifecycle register even if its self-attestation would otherwise pass', async () => {
    const { group, identity, tokens } = await lifecycleGroup()
    const recipient = agent(51)
    const members = await addMember(group, recipient, await bindingFor(recipient))
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, identity.id, {
        op: 'register',
        controller: controllerID,
      }).entry,
    )
    publish(tokens, [token])
    const message = await rawEnact(members.group, [token])
    await expect(members.joined.processMessage(message)).rejects.toThrow()
    expect(members.joined.registry.devices.size).toBe(0)
  })

  test('proof growth includes all previously recorded ledger history', async () => {
    const { group, identity } = await lifecycleGroup()
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
      snapshot: snapshotForChain(controllerID, [inception]),
      seal: 'a'.repeat(389120),
    })
    const log = [inception, rotation, revoke([inception, rotation], otherTarget)]
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, otherTarget, {
        effects: denyEffects(log.slice(1), otherTarget),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(log.slice(1)),
        revoked: [{ did: otherTarget }],
      }).entry,
    )
    const recorded = await enact(group, [token])
    const prior = log.at(-1)
    if (prior == null) throw new Error('Missing controller head')
    const next = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: prior.event,
      snapshot: snapshotForChain(controllerID, log),
      seal: 'a'.repeat(3072),
    })
    const suffix = [next, revoke([...log, next], target)]
    await expect(
      verifyLifecycleProof(
        recorded.group,
        proofEntry(identity.id, target, {
          effects: denyEffects(suffix, target),
          removed: [],
          op: 'revoke',
          proof: asControllerLog(suffix),
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'too-large' })
  })
})

describe('deny-gaining rotate proofs', () => {
  function authenticate(proof: Array<SignedEvent>, subject: string = target, floor = 0) {
    const registry = registrySeed()
    return authenticateLifecycleProof(
      controllerID,
      proofEntry(agent(41).id, subject, {
        effects: denyEffects(floor === 0 ? proof : proof.slice(-1), subject),
        removed: [],
        op: 'revoke',
        proof: asControllerLog(floor === 0 ? proof : proof.slice(-1)),
      }),
      {
        ...registry,
        controllers: new Map([
          [
            controllerID,
            {
              ...registryModule.controllerProjection(),
              genFloor: floor,
              ...(floor === 0
                ? {}
                : {
                    recordedLog: asControllerLog([
                      inception,
                      createReset(controllerSeed, 0, floor),
                    ]),
                  }),
            },
          ],
        ]),
      },
    )
  }

  test('authenticates a deny gain at its rotate position', () => {
    const chain: Array<SignedEvent> = [inception]
    chain.push(
      revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain, subject: target }),
    )
    expect(authenticate(chain).recordedLog.chain).toEqual(chain)
  })

  test('a plain rotate does not prove a revoke', () => {
    const chain: Array<SignedEvent> = [inception]
    chain.push(rotateChain({ seed: controllerSeed, profile: 0, did: controllerID, chain }))
    expect(() => authenticate(chain)).toThrow(expect.objectContaining({ reason: 'no-rev' }))
  })

  test('a later rotate retaining a denial keeps the gain position', () => {
    const chain: Array<SignedEvent> = [inception]
    chain.push(
      revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain, subject: target }),
    )
    chain.push(rotateChain({ seed: controllerSeed, profile: 0, did: controllerID, chain }))
    expect(authenticate(chain).recordedLog.chain).toEqual(chain)
  })

  test('re-revoking after a blind reset proves a new gain above the floor', () => {
    const chain: Array<SignedEvent> = [inception]
    chain.push(
      revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain, subject: target }),
    )
    chain.push(createReset(controllerSeed, 0, 1))
    chain.push(
      revokeChain({ seed: controllerSeed, profile: 0, did: controllerID, chain, subject: target }),
    )
    expect(authenticate(chain, target, 1).recordedLog.chain).toHaveLength(3)
  })

  test('normalises a denial written as a peer DID long form', async () => {
    const peer = await createIdentity({
      didMethod: 'peer:4',
      keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey: new Uint8Array(32).fill(89) }],
    })
    if (peer.longForm == null) throw new Error('Missing peer long form')
    expect(peer.longForm).not.toBe(normalizeDID(peer.id))
    const chain: Array<SignedEvent> = [inception]
    chain.push(
      revokeChain({
        seed: controllerSeed,
        profile: 0,
        did: controllerID,
        chain,
        subject: peer.longForm,
      }),
    )
    expect(authenticate(chain, normalizeDID(peer.id)).recordedLog.chain).toHaveLength(1 + 1)
  })

  test.each([false, true])('rejects chain revoke proofs with crit=%s', (crit) => {
    expect(() => authenticate([inception, chainRevoke(crit)])).toThrow(
      expect.objectContaining({ reason: 'not-authority-signed' }),
    )
  })

  test('a reset carrying a denial cannot prove a revoke without recorded history', () => {
    const reset = createReset(controllerSeed, 0, 1, { members: [], deny: [target] })
    expect(() => authenticate([inception, reset])).toThrow(
      expect.objectContaining({ reason: 'needs-reset' }),
    )
  })
})

describe('controller-log deny proofs', () => {
  async function fixture() {
    const f = await buildEpoch({ members: 2 })
    const setup = await lifecycleGroup(f.log.chain, f.log)
    const author = f.members[0]
    const other = f.members[1]
    if (author == null || other == null) throw new Error('Missing member')
    const rev = createRevoke({
      did: f.did,
      head: f.head,
      parents: epochHeads(f.did, f.log),
      signer: { member: author },
      target,
    })
    const claim = { kind: 'deny' as const, did: target, ref: { event: digestOf(rev.event) } }
    const value: DeviceValue = {
      op: 'revoke',
      proof: { chain: [], events: [rev] },
      effects: [claim],
      revoked: [{ did: target }],
      removed: [],
    }
    const entry = proofEntry(setup.identity.id, f.did, value)
    return { ...f, ...setup, author, other, rev, claim, value, entry }
  }

  test('member rev of an edge DID is a valid deny proof', async () => {
    const f = await fixture()
    const result = await verifyLifecycleProof(f.group, f.entry)
    expect(result.revoked).toEqual([{ did: target }])
    const registry = registryModule.registryApply(f.entry, f.group.registry, f.did)
    expect(registry.devices.get(target)).toEqual({
      controller: f.did,
      status: 'revoked',
      proofRef: { event: digestOf(f.rev.event) },
    })
  })

  test('root-rotate deny is proved by chain index', async () => {
    const { group, identity } = await lifecycleGroup()
    const rev = revoke([inception], target)
    const entry = proofEntry(identity.id, controllerID, {
      op: 'revoke',
      proof: { chain: [rev], events: [] },
      effects: [{ kind: 'deny', did: target, ref: { chainIndex: 1 } }],
      revoked: [{ did: target }],
      removed: [],
    })
    await expect(verifyLifecycleProof(group, entry)).resolves.toMatchObject({
      revoked: [{ did: target }],
    })
  })

  test('deny claim whose ref names an unrelated applied event is refused', async () => {
    const f = await fixture()
    f.value.effects = [{ ...f.claim, ref: { event: f.author.add } }]
    await expect(verifyLifecycleProof(f.group, f.entry)).rejects.toMatchObject({
      reason: 'effects-mismatch',
    })
  })

  test('undeclared effect in the delta is refused', async () => {
    const f = await fixture()
    const log = { chain: f.log.chain, events: [...f.log.events, f.rev] }
    const folded = foldControllerLog(f.did, log)
    if (!folded.ok) throw new Error(folded.reason)
    const second = createRevoke({
      did: f.did,
      head: folded.head,
      parents: epochHeads(f.did, log),
      signer: { member: f.other },
      target: otherTarget,
    })
    f.value.proof = { chain: [], events: [f.rev, second] }
    await expect(verifyLifecycleProof(f.group, f.entry)).rejects.toMatchObject({
      reason: 'effects-mismatch',
    })
  })

  test("revoke from a removed member's concurrent rev is refused", async () => {
    const f = await fixture()
    const rmv = createRemove({
      did: f.did,
      head: f.head,
      parents: epochHeads(f.did, f.log),
      signer: { member: f.other },
      add: f.author.add,
    })
    const registry = registryModule.registryForLog(f.did, {
      chain: f.log.chain,
      events: [...f.log.events, rmv],
    })
    expect(() => authenticateLifecycleProof(f.did, f.entry, registry)).toThrow(
      expect.objectContaining({ reason: 'not-endorsed' }),
    )
  })

  test('partial closure refused', async () => {
    const f = await fixture()
    const registry = registryModule.registryForLog(f.did, asControllerLog(f.log.chain))
    expect(() => authenticateLifecycleProof(f.did, f.entry, registry)).toThrow(
      expect.objectContaining({ constructor: RevokeProofError, reason: 'no-rev' }),
    )
  })

  test('saturated proof refused', async () => {
    const f = await fixture()
    const log = await saturatedLog()
    const folded = foldControllerLog(f.did, log)
    if (!folded.ok) throw new Error(folded.reason)
    expect(folded.head.saturated).toBe(true)
    const rev = createRevoke({
      did: f.did,
      head: folded.head,
      parents: [folded.head.epoch],
      signer: f.root,
      target,
    })
    f.value.proof = { chain: [], events: [...log.events, rev] }
    f.value.effects = [{ kind: 'deny', did: target, ref: { event: digestOf(rev.event) } }]
    expect(() => authenticateLifecycleProof(f.did, f.entry, f.group.registry)).toThrow(
      expect.objectContaining({ reason: 'too-large' }),
    )
  })

  test('deny read from head, not states.at(-1)', async () => {
    const f = await fixture()
    const folded = foldControllerLog(f.did, {
      chain: f.log.chain,
      events: [...f.log.events, f.rev],
    })
    expect(folded.ok && folded.states.at(-1)?.deny.has(target)).toBe(false)
    expect(folded.ok && folded.head.deny.has(target)).toBe(true)
    const result = await verifyLifecycleProof(f.group, f.entry)
    expect(result.revoked).toEqual([{ did: target }])
  })

  test('stored epoch deny upgrades to chain form after settle', async () => {
    const f = await fixture()
    const log: ControllerLog = { chain: f.log.chain, events: [...f.log.events, f.rev] }
    const folded = foldControllerLog(f.did, log)
    if (!folded.ok) throw new Error(folded.reason)
    const settle = createRotate({
      seed: f.seed,
      profile: 0,
      did: f.did,
      prior: f.inception.event,
      snapshot: snapshotOf(folded.head),
    })
    const before = registryModule.registryApply(f.entry, f.group.registry, f.did)
    const entry = proofEntry(f.identity.id, f.did, {
      op: 'log',
      proof: { chain: [settle], events: [] },
    })
    const registry = registryModule.registryApply(entry, before, f.did)
    vi.spyOn(f.group, 'registry', 'get').mockReturnValue(registry)
    const group = f.group
    expect(revocationOf(group, target)).toEqual({ controller: f.did, proofRef: { chainIndex: 1 } })
  })
})

test('reset carrying a new denial in its snapshot is ingested with a snapshot ref', async () => {
  const { group, identity } = await lifecycleGroup()
  const reset = createReset(controllerSeed, 0, 1, { members: [], deny: [target] })
  const value: DeviceValue = {
    op: 'reset',
    proof: asControllerLog([inception, reset]),
    effects: [{ kind: 'deny', did: target, ref: { snapshot: 1 } }],
    revoked: [{ did: identity.id }],
    removed: [],
  }
  const entry = proofEntry(identity.id, controllerID, value)
  await expect(verifyLifecycleProof(group, entry)).resolves.toMatchObject({
    revoked: [{ did: identity.id }],
    removed: [],
    removeLeafIndices: [0],
  })
  const registry = registryModule.registryApply(entry, group.registry, controllerID)
  expect(registry.devices.get(identity.id)).toEqual({
    controller: controllerID,
    status: 'revoked',
    reason: 'reset',
    proofRef: { snapshot: 1 },
  })
  expect(registry.devices.get(target)).toEqual({
    controller: controllerID,
    status: 'revoked',
    proofRef: { snapshot: 1 },
  })
  expect(registry.controllers.get(controllerID)?.genFloor).toBe(1)
  value.effects = [{ kind: 'deny', did: target, ref: { chainIndex: 1 } }]
  expect(() => authenticateLifecycleProof(controllerID, entry, group.registry)).toThrow(
    expect.objectContaining({ reason: 'no-rev' }),
  )
})

test('reset snapshot denial evicts a leaf with a current-generation prefix', async () => {
  const { group, identity } = await lifecycleGroup()
  const device = agent(61)
  const prefix = [inception, createReset(controllerSeed, 0, 1)]
  const added = await addMember(group, device, await bindingFor(device, prefix))
  const reset = createReset(controllerSeed, 0, 1, { members: [], deny: [device.id] })
  const entry = proofEntry(identity.id, controllerID, {
    op: 'reset',
    proof: asControllerLog([inception, reset]),
    effects: [{ kind: 'deny', did: device.id, ref: { snapshot: 1 } }],
    revoked: [{ did: identity.id }],
    removed: [],
  })
  const effects = await verifyLifecycleProof(added.group, entry)
  expect(effects.revoked).toEqual([{ did: identity.id }])
  expect(effects.removeLeafIndices).toEqual([0, 1])
})

test('a denial after reset gives its current-generation cascade the denial reference', async () => {
  const current = [inception, createReset(controllerSeed, 0, 1)]
  const { group, identity } = await lifecycleGroup(current)
  const issuer = agent(51)
  const child = agent(61)
  const first = await addMember(group, issuer, await bindingFor(issuer, current))
  const added = await addUnevidenced(
    first.group,
    child,
    await bindingFor(child, current, {
      identity: issuer,
      parent: await trustedGrant(issuer, current),
    }),
  )
  const log = asControllerLog([...current, revoke(current, issuer.id)])
  const entry = proofEntry(identity.id, controllerID, {
    op: 'reset',
    proof: log,
    effects: [{ kind: 'deny', did: issuer.id, ref: { chainIndex: 2 } }],
    revoked: [{ did: child.id, cascadedFrom: issuer.id }],
    removed: [],
  })
  await expect(verifyLifecycleProof(added.group, entry)).resolves.toMatchObject({
    genFloor: 1,
    revoked: [{ did: child.id, cascadedFrom: issuer.id }],
    removeLeafIndices: [1, 2],
  })
  const token = await signLedgerEntry(identity, entry.entry)
  const replay = deriveGroup(added.group, added.group.state)
  await replay.applyLedgerEntries([token])
  expect(replay.registry.devices.get(child.id)?.proofRef).toEqual({ chainIndex: 2 })
  const revocation = revocationOf(replay, child.id)
  expect(revocation).toEqual({
    controller: controllerID,
    proofRef: { chainIndex: 2 },
    reason: 'reset',
    cascadedFrom: issuer.id,
  })
  if (revocation?.cascadedFrom == null) throw new Error('Missing cascade revocation')
  const { cascadedFrom, proofRef } = revocation
  expect(() =>
    effectOf(controllerID, log, { kind: 'deny', did: cascadedFrom, ref: proofRef }, 1),
  ).not.toThrow()
})

test('deny cascade keeps evidenced children', async () => {
  const { group, identity } = await lifecycleGroup()
  const issuer = agent(51)
  const child = agent(61)
  const first = await addMember(group, issuer, await bindingFor(issuer))
  const binding = await bindingFor(child, [inception], {
    identity: issuer,
    parent: await trustedGrant(issuer),
  })
  const added = await addMember(first.group, child, binding)
  const entry = proofEntry(identity.id, controllerID, {
    op: 'revoke',
    proof: asControllerLog([revoke([inception], issuer.id)]),
    effects: [{ kind: 'deny', did: issuer.id, ref: { chainIndex: 1 } }],
    revoked: [{ did: issuer.id }],
    removed: [],
  })
  const effects = await verifyLifecycleProof(added.group, entry)
  expect(effects.revoked).toEqual([{ did: issuer.id }])
  expect(effects.removeLeafIndices).toEqual([1])
  expect(added.group.findMemberLeafIndex(child.id)).toBe(2)
})
