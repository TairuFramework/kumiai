import { audienceConfirmation } from '@kokuin/capability'
import {
  createControllerIdentity,
  createInception,
  createRevoke,
  didFromInception,
  foldLog,
  type SignedEvent,
} from '@kokuin/controller'
import { type OwnIdentity, stringifyToken } from '@kokuin/token'
import { defaultProposalTypes, encode, mlsMessageEncoder } from 'ts-mls'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { mintTrustedGrant, readCapability } from '../src/capability.js'
import type { ControllerBinding } from '../src/credential.js'
import { LeafBindingError, RevokeProofError } from '../src/errors.js'
import { commitLedgerEntries } from '../src/group-commit.js'
import { CommitRejectedError, deriveGroup, type GroupHandle } from '../src/group-handle.js'
import { renewLeaf, revokeWithProof } from '../src/group-lifecycle.js'
import { signLedgerEntry, type VerifiedLedgerEntry } from '../src/ledger.js'
import { leafAt } from '../src/lifecycle.js'
import { verifyLifecycleProof } from '../src/lifecycle-proof.js'
import { DEVICE_ENTRY_TYPE, type DeviceValue } from '../src/registry.js'
import { controllerSeed } from './fixtures/lifecycle-ledger.js'
import {
  agent,
  controllerID,
  inception,
  lowLevelWelcome,
  pipelineGroup,
  rawAdd,
  rawCommit,
  rawUpdate,
  timedBinding,
  welcomeBoundary,
  withoutHolderEvidence,
} from './fixtures/lifecycle-pipeline.js'

function revoke(log: Array<SignedEvent>, subject: string): SignedEvent {
  const folded = foldLog(controllerID, log)
  const head = folded.ok ? folded.states.at(-1) : undefined
  const prior = log.at(-1)
  if (head == null || prior == null) throw new Error('Missing head')
  return createRevoke({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: prior.event,
    target: subject,
    keyPosition: { gen: head.keyGen, seq: head.keySeq },
  })
}

async function parentGrant(identity: OwnIdentity, iat: number): Promise<string> {
  vi.spyOn(Date, 'now').mockReturnValue(iat * 1000)
  const grant = await mintTrustedGrant({
    signer: createControllerIdentity({ seed: controllerSeed, profile: 0, log: [inception] }),
    controllerID,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: 1000,
  })
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
  return grant
}

async function publishLedger(tokens: Map<string, string>, group: GroupHandle): Promise<void> {
  for (const held of group.ledger) tokens.set(held.entryID, held.token)
}

async function expectRejected(
  pending: Promise<unknown>,
  reason: string,
  cause: string,
): Promise<void> {
  const error = await pending.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(CommitRejectedError)
  expect((error as CommitRejectedError).reason).toBe(reason)
  expect((error as Error).cause).toMatchObject({ reason: cause })
}

type SetupOptions = {
  /** The child's leaf carries no holder evidence; it enters below the acceptance gate. */
  unevidenced?: boolean
  parentIat?: number
  childIat?: number
}

/**
 * The publisher P (direct leaf), the trusted device A (direct leaf), a bystander E (direct leaf)
 * and the child B, whose leaf A issued under its trusted grant.
 */
async function ownAgents(options: SetupOptions = {}) {
  const { group, identity, tokens } = await pipelineGroup()
  const issuer = agent(51)
  const bystander = agent(71)
  const child = agent(61)
  const withIssuer = await lowLevelWelcome(
    group,
    issuer,
    await timedBinding({ identity: issuer, iat: 90, exp: 200 }),
  )
  const withBystander = await lowLevelWelcome(
    withIssuer.author,
    bystander,
    await timedBinding({ identity: bystander, iat: 90, exp: 200 }),
  )
  const parent = await parentGrant(issuer, options.parentIat ?? 95)
  const childBinding = await timedBinding({
    identity: child,
    iat: options.childIat ?? 110,
    exp: 200,
    issuer,
    parent,
  })
  const log = [inception, revoke([inception], issuer.id)]
  if (options.unevidenced) {
    const added = await rawAdd(withBystander.author, child, withoutHolderEvidence(childBinding))
    return {
      publisher: deriveGroup(withBystander.author, added.result.newState),
      childHandle: undefined,
      bystanderHandle: withBystander.joined,
      identity,
      issuer,
      bystander,
      child,
      parent,
      tokens,
      log,
    }
  }
  const withChild = await lowLevelWelcome(withBystander.author, child, childBinding)
  return {
    publisher: withChild.author,
    childHandle: withChild.joined,
    bystanderHandle: withBystander.joined,
    identity,
    issuer,
    bystander,
    child,
    parent,
    tokens,
    log,
  }
}

/** Publish the issuer's proof from P and deliver it to B. */
async function afterIssuerProof(options: SetupOptions = {}) {
  const setup = await ownAgents(options)
  const built = await revokeWithProof(setup.publisher, {
    subject: setup.issuer.id,
    log: setup.log,
  })
  if (built.status !== 'built') throw new Error(`Proof not built: ${JSON.stringify(built)}`)
  await publishLedger(setup.tokens, built.result.newGroup)
  const child = setup.childHandle
  if (child == null) throw new Error('Missing child handle')
  await child.processMessage(built.result.commitMessage)
  return { ...setup, built, publisher: built.result.newGroup, childHandle: child }
}

function proofValue(entry: VerifiedLedgerEntry): DeviceValue {
  return entry.entry.value as DeviceValue
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(150_000)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('revocation cascade', () => {
  test('chainedLeafWithoutHolderEvidenceStillCascaded', async () => {
    const setup = await ownAgents({ unevidenced: true })
    const childIndex = setup.publisher.findMemberLeafIndex(setup.child.id)
    expect(childIndex).toBeDefined()
    const built = await revokeWithProof(setup.publisher, {
      subject: setup.issuer.id,
      log: setup.log,
    })
    expect(built.status).toBe('built')
    if (built.status !== 'built') throw new Error('Missing proof')
    const entry = built.result.newGroup.ledger.at(-1)?.verified
    if (entry == null) throw new Error('Missing proof entry')
    expect(proofValue(entry).revoked).toEqual([
      { did: setup.issuer.id },
      { did: setup.child.id, cascadedFrom: setup.issuer.id },
    ])
    expect(built.result.newGroup.findMemberLeafIndex(setup.child.id)).toBeUndefined()
    // A receiver re-derives the cascade and refuses a proof that leaves the child out.
    await expect(
      verifyLifecycleProof(setup.publisher, {
        ...entry,
        entry: {
          ...entry.entry,
          value: { ...proofValue(entry), revoked: [{ did: setup.issuer.id }] },
        },
      } as VerifiedLedgerEntry<DeviceValue>),
    ).rejects.toMatchObject({ reason: 'effects-mismatch' })
  })

  test('evidencedChildSurvivesProofAndWelcome', async () => {
    const setup = await ownAgents()
    const built = await revokeWithProof(setup.publisher, {
      subject: setup.issuer.id,
      log: setup.log,
    })
    expect(built.status).toBe('built')
    if (built.status !== 'built') throw new Error('Missing proof')
    const entry = built.result.newGroup.ledger.at(-1)?.verified
    if (entry == null) throw new Error('Missing proof entry')
    expect(proofValue(entry).revoked).toEqual([{ did: setup.issuer.id }])
    expect(built.result.newGroup.findMemberLeafIndex(setup.issuer.id)).toBeUndefined()
    expect(built.result.newGroup.findMemberLeafIndex(setup.child.id)).toBeDefined()
    // A receiver refuses a proof that declares the evidenced child cascaded.
    await expect(
      verifyLifecycleProof(setup.publisher, {
        ...entry,
        entry: {
          ...entry.entry,
          value: {
            ...proofValue(entry),
            revoked: [
              { did: setup.issuer.id },
              { did: setup.child.id, cascadedFrom: setup.issuer.id },
            ],
          },
        },
      } as VerifiedLedgerEntry<DeviceValue>),
    ).rejects.toMatchObject({ reason: 'effects-mismatch' })

    // The child itself adopts the proof and stays.
    await publishLedger(setup.tokens, built.result.newGroup)
    const child = setup.childHandle
    if (child == null) throw new Error('Missing child handle')
    await child.processMessage(built.result.commitMessage)
    expect(child.state.groupActiveState.kind).toBe('active')
    expect(child.epoch).toBe(built.result.newGroup.epoch)
    expect(child.registry.devices.get(setup.issuer.id)?.status).toBe('revoked')
    expect(child.findMemberLeafIndex(setup.issuer.id)).toBeUndefined()

    // A device joining afterwards through the public Welcome path accepts the evidenced child.
    const joiner = agent(81)
    const welcome = await welcomeBoundary(
      built.result.newGroup,
      joiner,
      await timedBinding({ identity: joiner, iat: 100, exp: 200 }),
    )
    const joined = await welcome.process()
    expect(joined.group.findMemberLeafIndex(setup.child.id)).toBeDefined()
    expect(joined.group.registry.devices.get(setup.issuer.id)?.status).toBe('revoked')
    const childLeaf = leafAt(
      joined.group.state.ratchetTree,
      joined.group.findMemberLeafIndex(setup.child.id) ?? -1,
    )
    if (childLeaf == null || !('identity' in childLeaf.credential))
      throw new Error('Missing child leaf')
    const binding = JSON.parse(new TextDecoder().decode(childLeaf.credential.identity)).controller
    expect(readCapability(binding.capability).payload.iss).toBe(setup.issuer.id)
  })

  test('deniedIssuerLeafWithoutHolderEvidenceRefusedInWelcome', async () => {
    const setup = await ownAgents({ unevidenced: true })
    const issuerIndex = setup.publisher.findMemberLeafIndex(setup.issuer.id)
    if (issuerIndex == null) throw new Error('Missing issuer')
    // A proof that leaves the unevidenced child behind, built below the acceptance gate.
    const token = await signLedgerEntry(setup.identity, {
      type: DEVICE_ENTRY_TYPE,
      groupID: setup.publisher.groupID,
      subject: setup.issuer.id,
      value: { op: 'revoke', proof: setup.log, revoked: [{ did: setup.issuer.id }] },
    })
    const forged = await rawCommit({
      group: setup.publisher,
      proposals: [{ proposalType: defaultProposalTypes.remove, remove: { removed: issuerIndex } }],
      tokens: [token],
    })
    const forgedGroup = deriveGroup(setup.publisher, forged.newState)
    await forgedGroup.applyLedgerEntries([token])
    expect(forgedGroup.registry.devices.get(setup.issuer.id)?.status).toBe('revoked')
    expect(forgedGroup.findMemberLeafIndex(setup.child.id)).toBeDefined()
    const joiner = agent(81)
    const welcome = await welcomeBoundary(
      forgedGroup,
      joiner,
      await timedBinding({ identity: joiner, iat: 100, exp: 200 }),
    )
    const error = await welcome.process().then(
      () => undefined,
      (thrown: unknown) => thrown,
    )
    expect(error).toBeInstanceOf(LeafBindingError)
    expect((error as LeafBindingError).reason).toBe('missing-holder-evidence')
  })

  test('repeatProofForSubjectWithExemptChildrenNotEffectsMismatch', async () => {
    const { built, publisher, childHandle, child, issuer, log } = await afterIssuerProof()
    expect(built.status).toBe('built')
    expect(publisher.findMemberLeafIndex(child.id)).toBeDefined()
    expect(childHandle.findMemberLeafIndex(child.id)).toBeDefined()
    expect(await revokeWithProof(publisher, { subject: issuer.id, log })).toEqual({
      status: 'already-revoked',
    })
    expect(await revokeWithProof(childHandle, { subject: issuer.id, log })).toEqual({
      status: 'already-revoked',
    })
  })
})

describe('commit authentication of evidenced children', () => {
  test('survivorControlCommitAfterIssuerProofAccepted', async () => {
    const { publisher, childHandle, child, tokens } = await afterIssuerProof()
    const note = await signLedgerEntry(child, {
      type: 'test.note',
      groupID: childHandle.groupID,
      subject: child.id,
      value: 'after the proof',
    })
    const committed = await commitLedgerEntries(childHandle, [note])
    await publishLedger(tokens, committed.newGroup)
    await publisher.processMessage(committed.commitMessage)
    expect(publisher.epoch).toBe(committed.epoch)
    expect(publisher.ledger.at(-1)?.verified.entry.type).toBe('test.note')
    expect(publisher.findMemberLeafIndex(child.id)).toBeDefined()
  })

  test('survivorPublishesSecondRevocationBeforeRenewal', async () => {
    const { publisher, childHandle, bystander, log, tokens } = await afterIssuerProof()
    const second = await revokeWithProof(childHandle, {
      subject: bystander.id,
      log: [...log, revoke(log, bystander.id)],
    })
    expect(second.status).toBe('built')
    if (second.status !== 'built') throw new Error('Missing second proof')
    const entry = second.result.newGroup.ledger.at(-1)?.verified
    if (entry == null) throw new Error('Missing second proof entry')
    expect(proofValue(entry).revoked).toEqual([{ did: bystander.id }])
    await publishLedger(tokens, second.result.newGroup)
    await publisher.processMessage(second.result.commitMessage)
    expect(publisher.epoch).toBe(second.result.epoch)
    expect(publisher.findMemberLeafIndex(bystander.id)).toBeUndefined()
    expect(publisher.registry.devices.get(bystander.id)?.status).toBe('revoked')
  })

  test('newlyIntroducedDeniedIssuerCapabilityRefusedInCommitPath', async () => {
    const { publisher, childHandle, child, issuer, parent, bystander, log, tokens } =
      await afterIssuerProof()
    // A stolen issuer key mints a fresh leaf for the child, with fresh holder evidence.
    const fresh = await timedBinding({ identity: child, iat: 120, exp: 200, issuer, parent })
    expect(fresh.holderGrant).toBeDefined()
    const commit = await rawCommit({ group: childHandle, binding: fresh })
    await expectRejected(
      publisher.processMessage(encode(mlsMessageEncoder, commit.commit)),
      'binding',
      'denied-issuer',
    )
    expect(publisher.epoch).toBe(childHandle.epoch)

    // The same fresh leaf on the path of an otherwise valid proof commit is refused when its
    // credential is authenticated, before any later check sees it.
    const proof = await revokeWithProof(childHandle, {
      subject: bystander.id,
      log: [...log, revoke(log, bystander.id)],
    })
    if (proof.status !== 'built') throw new Error('Missing second proof')
    const bystanderIndex = childHandle.findMemberLeafIndex(bystander.id)
    if (bystanderIndex == null) throw new Error('Missing bystander')
    await publishLedger(tokens, proof.result.newGroup)
    const proofWithFreshLeaf = await rawCommit({
      group: childHandle,
      binding: fresh,
      proposals: [
        { proposalType: defaultProposalTypes.remove, remove: { removed: bystanderIndex } },
      ],
      tokens: proof.result.newGroup.ledgerTokens.slice(childHandle.ledgerTokens.length),
    })
    await expectRejected(
      publisher.processMessage(encode(mlsMessageEncoder, proofWithFreshLeaf.commit)),
      'binding',
      'denied-issuer',
    )
    expect(publisher.findMemberLeafIndex(bystander.id)).toBeDefined()
  })

  test('deniedIssuerCannotRenewAfterProof', async () => {
    const { publisher, childHandle, child, issuer, parent } = await afterIssuerProof()
    const fresh = await timedBinding({ identity: child, iat: 120, exp: 200, issuer, parent })
    await expect(renewLeaf(childHandle, fresh)).rejects.toMatchObject({ reason: 'denied-issuer' })
    await expectRejected(
      publisher.processMessage(await rawUpdate(childHandle, child, fresh)),
      'binding',
      'denied-issuer',
    )
  })
})

describe('renewal order', () => {
  test('directCLeafReplacesNewerLeafOfRecordedRevokedIssuer', async () => {
    const { publisher, childHandle, child, issuer, tokens } = await afterIssuerProof()
    const current = childHandle.bindingOfDID(child.id)?.capability
    if (current == null) throw new Error('Missing child capability')
    expect(readCapability(current).payload.iat).toBe(110)
    const direct = await timedBinding({ identity: child, iat: 105, exp: 200 })
    expect(childHandle.registry.devices.get(issuer.id)?.status).toBe('revoked')
    const renewal = await renewLeaf(childHandle, direct)
    await publishLedger(tokens, renewal.newGroup)
    await publisher.processMessage(renewal.commitMessage)
    expect(publisher.epoch).toBe(renewal.epoch)
    const installed = publisher.bindingOfDID(child.id)?.capability
    if (installed == null) throw new Error('Missing installed capability')
    expect(readCapability(installed).payload).toMatchObject({ iss: controllerID, iat: 105 })
    expect(readCapability(installed).payload.cap).toBeUndefined()
  })

  test('directCLeafOlderThanCurrentRefusedWhenIssuerNotRevoked', async () => {
    const setup = await ownAgents()
    const childHandle = setup.childHandle
    if (childHandle == null) throw new Error('Missing child handle')
    expect(childHandle.registry.devices.get(setup.issuer.id)?.status).not.toBe('revoked')
    const direct = await timedBinding({ identity: setup.child, iat: 105, exp: 200 })
    await expect(renewLeaf(childHandle, direct)).rejects.toMatchObject({ reason: 'renewal-order' })
    await expectRejected(
      setup.publisher.processMessage(
        encode(
          mlsMessageEncoder,
          (await rawCommit({ group: childHandle, binding: direct })).commit,
        ),
      ),
      'binding',
      'renewal-order',
    )
    // Signed after the controller revoked the issuer: denied at that head, not in the group.
    const afterRev = await timedBinding({
      identity: setup.child,
      iat: 105,
      exp: 200,
      prefix: setup.log,
    })
    await expect(renewLeaf(childHandle, afterRev)).rejects.toMatchObject({
      reason: 'renewal-order',
    })
    await expectRejected(
      setup.publisher.processMessage(
        encode(
          mlsMessageEncoder,
          (await rawCommit({ group: childHandle, binding: afterRev })).commit,
        ),
      ),
      'binding',
      'renewal-order',
    )
  })

  test('directCLeafReplacementKeepsOtherChecks', async () => {
    const { childHandle, child } = await afterIssuerProof()
    const controller = createControllerIdentity({
      seed: controllerSeed,
      profile: 0,
      log: [inception],
    })
    const wrongKey: ControllerBinding = {
      id: controllerID,
      prefix: [inception],
      capability: stringifyToken(
        await controller.signToken({
          sub: controllerID,
          aud: child.id,
          act: 'authenticate',
          res: 'kumiai/mls-leaf',
          cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: agent(99).publicKey }),
          iat: 105,
          exp: 200,
        }),
      ),
    }
    await expect(renewLeaf(childHandle, wrongKey)).rejects.toMatchObject({
      reason: 'confirmation-invalid',
    })

    const otherSeed = new Uint8Array(32).fill(32)
    const otherInception = createInception(otherSeed, 0)
    const otherID = didFromInception(otherInception.event)
    const other = createControllerIdentity({ seed: otherSeed, profile: 0, log: [otherInception] })
    const otherController: ControllerBinding = {
      id: otherID,
      prefix: [otherInception],
      capability: stringifyToken(
        await other.signToken({
          sub: otherID,
          aud: child.id,
          act: 'authenticate',
          res: 'kumiai/mls-leaf',
          cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: child.publicKey }),
          iat: 105,
          exp: 200,
        }),
      ),
    }
    await expect(renewLeaf(childHandle, otherController)).rejects.toMatchObject({
      reason: 'controller-mismatch',
    })

    const overlong = await timedBinding({ identity: child, iat: 105, exp: 105 + 86_401 })
    await expect(renewLeaf(childHandle, overlong)).rejects.toMatchObject({ reason: 'lifetime-cap' })

    // The child's leaf attests its parent grant's issuance (108), the newest in the tree.
    const late = await afterIssuerProof({ parentIat: 108 })
    const regressing = await timedBinding({ identity: late.child, iat: 102, exp: 200 })
    const commit = await rawCommit({ group: late.childHandle, binding: regressing })
    const error = await late.publisher
      .processMessage(encode(mlsMessageEncoder, commit.commit))
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      )
    expect(error).toBeInstanceOf(CommitRejectedError)
    expect((error as CommitRejectedError).reason).toBe('floor')
    expect((error as Error).cause).toBeInstanceOf(RevokeProofError)
    expect((error as Error).cause).toMatchObject({ reason: 'time-regression' })
  })
})
