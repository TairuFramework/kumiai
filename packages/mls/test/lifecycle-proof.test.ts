import {
  createReset,
  createRevoke,
  createRotate,
  foldLog,
  type SignedEvent,
} from '@kokuin/controller'
import { normalizeDID } from '@kokuin/token'
import { beforeAll, describe, expect, test } from 'vitest'

import { verifyLeafCredential } from '../src/authentication.js'
import { readCapability } from '../src/capability.js'
import { foldEnvelope } from '../src/envelope-fold.js'
import { restoreGroup } from '../src/group-create.js'
import { makeMLSCredential } from '../src/group-credential.js'
import { deriveGroup } from '../src/group-handle.js'
import type { VerifiedLedgerEntry } from '../src/ledger.js'
import { signLedgerEntry } from '../src/ledger.js'
import { verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue, revocationOf } from '../src/registry.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
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

function revoke(log: Array<SignedEvent>, subject: string): SignedEvent {
  const folded = foldLog(controllerID, log)
  if (!folded.ok) throw new Error(folded.reason)
  const head = folded.states.at(-1)
  const prior = log.at(-1)
  if (head == null || prior == null) throw new Error('Missing controller head')
  return createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: prior.event,
    target: subject,
    keyPosition: { gen: head.keyGen, seq: head.keySeq },
  })
}

function proofEntry(
  issuer: string,
  subject: string,
  value: DeviceValue,
): VerifiedLedgerEntry<DeviceValue> {
  return { issuer, entry: { type: DEVICE_ENTRY_TYPE, groupID: 'lifecycle-ledger', subject, value } }
}

async function recordFirst() {
  const setup = await lifecycleGroup()
  const log = [inception, revoke([inception], otherTarget)]
  const verified = proofEntry(setup.identity.id, otherTarget, {
    op: 'revoke',
    proof: log,
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
        op: 'revoke',
        proof: log,
        revoked: [{ did: target }],
      }),
    )
    expect(effects).toMatchObject({
      controller: controllerID,
      logPosition: 1,
      recordedLog: log,
      genFloor: 0,
      timeFloor: 0,
      revoked: [{ did: target }],
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
          op: 'revoke',
          proof: [inception],
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
          op: 'revoke',
          controller: 'did:kokuin:foreign',
          proof: [foreign],
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
          createRevoke({
            seed: controllerSeed,
            profile: 0,
            did: controllerID,
            prior: inception.event,
            target,
            keyPosition: { gen: 0, seq: 0 },
            cap: 'delegated-management',
          }),
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
        expect(foldLog(controllerID, proof).ok).toBe(true)
      }
      await expect(
        verifyLifecycleProof(
          group,
          proofEntry(identity.id, target, {
            op: 'revoke',
            proof,
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
          op: 'revoke',
          proof: [revoke([inception], target)],
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
          op: 'revoke',
          proof: [reset, revoke([inception, reset], target)],
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
            op: 'revoke',
            proof,
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
      options: { seal: '界'.repeat(131072) },
    })
    const proof = [inception, rotation, revoke([inception, rotation], target)]
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          op: 'revoke',
          proof,
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'too-large' })
  })

  test('allows a first chain re-parented on a reset', async () => {
    const { group, identity } = await lifecycleGroup()
    const reset = createReset(controllerSeed, 0, 1)
    const log = [inception, reset, revoke([inception, reset], target)]
    const effects = await verifyLifecycleProof(
      group,
      proofEntry(identity.id, target, {
        op: 'revoke',
        proof: log,
        revoked: [{ did: target }],
      }),
    )
    expect(effects.recordedLog).toEqual(log)
    expect(effects.logPosition).toBe(2)
    expect(effects.genFloor).toBe(0)
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
        log.push(
          createRotate({
            seed: controllerSeed,
            profile: 0,
            did: controllerID,
            prior: prior.event,
            options: { keyPosition: { gen: 0, seq: index } },
          }),
        )
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
            op: 'revoke',
            proof: firstLog,
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
            op: 'revoke',
            proof: proofSuffix,
            revoked: [{ did: target }],
          }).entry,
        )
        const live = await enact(first.group, [secondToken])
        publish(initial.tokens, [secondToken])
        expect(live.group.registry.controllers.get(controllerID)?.recordedLog).toEqual(log)
        expect(revocationOf(live.group, target)).toEqual({
          controller: controllerID,
          logPosition: 52,
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

  test('an empty suffix proves another rev already in the recorded log', async () => {
    const { group, identity } = await lifecycleGroup()
    const log = [inception, revoke([inception], otherTarget)]
    log.push(revoke(log, target))
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, otherTarget, {
        op: 'revoke',
        proof: log,
        revoked: [{ did: otherTarget }],
      }).entry,
    )
    const recorded = await enact(group, [token])
    const effects = await verifyLifecycleProof(
      recorded.group,
      proofEntry(identity.id, target, {
        op: 'revoke',
        proof: [],
        revoked: [{ did: target }],
      }),
    )
    expect(effects.recordedLog).toEqual(log)
    expect(effects.logPosition).toBe(2)
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
      options: { keyPosition: { gen: 0, seq: 0 }, denySnapshot: [] },
    })
    const nextLog = [...log, rotation]
    nextLog.push(revoke(nextLog, target))
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, target, {
        op: 'revoke',
        proof: nextLog.slice(2),
        revoked: [{ did: target }],
      }).entry,
    )
    const next = await enact(group, [token])
    expect(next.group.registry.devices.get(otherTarget)?.status).toBe('revoked')
    expect(next.group.currentDenySet().has(normalizeDID(otherTarget))).toBe(true)
    expect(revocationOf(next.group, otherTarget)).toEqual({
      controller: controllerID,
      logPosition: 1,
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
      op: 'revoke',
      proof: [inception, revoke([inception], trusted.id)],
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
      op: 'reset',
      proof: [inception, reset],
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
      recordedLog: [inception, reset],
      genFloor: 1,
      timeFloor: 0,
    })
    expect(revocationOf(replay, identity.id)).toEqual({
      controller: controllerID,
      logPosition: 1,
      reason: 'reset',
    })
    expect(revocationOf(replay, otherTarget)).toEqual({ controller: controllerID, logPosition: 1 })
    await expect(
      verifyLifecycleProof(
        replay,
        proofEntry(identity.id, target, {
          op: 'revoke',
          proof: [inception, revoke([inception], target)],
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
  test('an empty first proof has no revocation', async () => {
    const { group, identity } = await lifecycleGroup()
    await expect(
      verifyLifecycleProof(
        group,
        proofEntry(identity.id, target, {
          op: 'revoke',
          proof: [],
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
          op: 'revoke',
          proof: full,
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'detached' })
  })

  test('a second reset to the same generation cannot raise its floor', async () => {
    const reset = createReset(controllerSeed, 0, 1)
    const { group, identity } = await lifecycleGroup([inception, reset])
    const entry = proofEntry(identity.id, controllerID, {
      op: 'reset',
      proof: [inception, reset],
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
          op: 'revoke',
          proof: [inception, revoke([inception], otherTarget)],
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
      options: { seal: '界'.repeat(131072) },
    })
    const device = agent(61)
    const members = await addMember(group, device, await bindingFor(device, [inception, rotation]))
    const effects = await verifyLifecycleProof(
      members.group,
      proofEntry(identity.id, device.id, {
        op: 'revoke',
        proof: [inception, revoke([inception], device.id)],
        revoked: [{ did: device.id }],
      }),
    )
    expect(effects.removeLeafIndices).toEqual([1])
  })

  test('rotation preserves a previously issued leaf grant', async () => {
    const { group, identity } = await lifecycleGroup()
    const binding = await bindingFor(identity)
    const rotation = createRotate({
      seed: controllerSeed,
      profile: 0,
      did: controllerID,
      prior: inception.event,
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
        op: 'reset',
        proof: current,
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
        op: 'reset',
        proof: current,
        revoked: effects.revoked,
      }).entry,
    )
    const replay = deriveGroup(withChild.group, withChild.group.state)
    await replay.applyLedgerEntries([token])
    expect(revocationOf(replay, child.id)).toEqual({
      controller: controllerID,
      logPosition: 1,
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
        op: 'reset',
        proof: prefix,
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
    expect(members.joined.ledgerTokens).toEqual([token])
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
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, target, {
        op: 'revoke',
        proof: [inception, revoke([inception], target)],
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
    expect(members.joined.ledgerTokens).toEqual([])
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
      options: { seal: 'a'.repeat(389120) },
    })
    const log = [inception, rotation, revoke([inception, rotation], otherTarget)]
    const token = await signLedgerEntry(
      identity,
      proofEntry(identity.id, otherTarget, {
        op: 'revoke',
        proof: log,
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
      options: { keyPosition: { gen: 0, seq: 1 }, seal: 'a'.repeat(3072) },
    })
    const suffix = [next, revoke([...log, next], target)]
    await expect(
      verifyLifecycleProof(
        recorded.group,
        proofEntry(identity.id, target, {
          op: 'revoke',
          proof: suffix,
          revoked: [{ did: target }],
        }),
      ),
    ).rejects.toMatchObject({ reason: 'too-large' })
  })
})
