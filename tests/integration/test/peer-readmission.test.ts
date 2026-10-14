import { createHash } from 'node:crypto'
import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  decodeClientState,
  encodeClientState,
  ledgerEntryDigest,
  removeMember,
  restoreGroup,
} from '@kumiai/mls'
import { deriveEntryKey, sealEntries } from '@kumiai/mls-rpc'
import {
  asLogPosition,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { judgeWelcomeAdmission } from '../../../packages/mls-hub/src/admission.js'
import { openWelcome } from '../../../packages/mls-hub/src/join.js'
import { createLastResortProvisioner } from '../../../packages/mls-hub/src/provisioner.js'
import { createMemoryLastResortStore } from '../../../packages/mls-hub/src/store.js'
import { createTestHub } from '../../../packages/mls-hub/test/fixtures/hub.js'
import { createMemoryHostDatabase } from './host-db.js'

test('a last-resort Welcome replaces held state three epochs ahead and spent repeats are refused', async () => {
  const hub = createTestHub()
  try {
    const store = createMemoryLastResortStore()
    const source = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store,
    })
    const { ref } = await source.ensureProvisioned().value
    const [bundle] = await source.bundles()
    if (bundle == null) throw new Error('Missing last-resort bundle')
    const inviter = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`Missing ledger entry ${id}`)
        return token
      })
    let { group } = await createGroup(inviter, 'welcome-readmission', { resolveLedgerEntries })
    const invite = async (recipientDID: string) => {
      const { invite } = await createInvite({
        group,
        identity: inviter,
        recipientDID,
        permission: 'member',
      })
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
      return invite
    }
    const firstInvite = await invite(hub.identity.id)
    const first = await commitInvite(group, bundle.publicPackage, firstInvite)
    group = first.newGroup
    const firstWelcome = {
      identity: hub.identity,
      invite: firstInvite,
      welcome: first.welcomeMessage,
      ratchetTree: group.state.ratchetTree,
      options: { resolveLedgerEntries },
    }
    const opened = await openWelcome([source], firstWelcome)
    if (!('joined' in opened)) throw new Error('Expected initial join')
    const held = opened.joined.group
    const spentEpochAuthenticators = [held.state.keySchedule.epochAuthenticator.slice()]
    const oldBranchMember = randomIdentity()
    const oldBundle = await createKeyPackageBundle(oldBranchMember)
    const oldInvite = await invite(oldBranchMember.id)
    const oldEpoch = Number(group.epoch)
    const oldCommit = await commitInvite(group, oldBundle.publicPackage, oldInvite)
    const oldPayload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(
        oldCommit.commitMessage,
        sealEntries(await deriveEntryKey(group), encodeLedgerEntries(oldInvite.ledgerEntries)),
      ),
    )
    group = oldCommit.newGroup
    await held.processMessage(oldCommit.commitMessage)
    spentEpochAuthenticators.push(held.state.keySchedule.epochAuthenticator.slice())
    const epoch = Number(held.epoch)
    const db = createMemoryHostDatabase()
    const oldPosition = asLogPosition('00000000000000000001')
    const oldApplied = {
      epoch: oldEpoch,
      digest: digestAppliedCommit(oldCommit.commitMessage),
      payloadDigest: createHash('sha256').update(oldPayload).digest('base64url'),
      sequenceID: oldPosition,
      opID: null,
      removed: false,
    }
    await db.saveState(held.groupID, encodeClientState(held.state), {
      mutationID: 'old-branch-adoption',
      changes: {
        putApplied: [oldApplied],
        putResponses: [
          { position: oldPosition, digest: oldApplied.digest, kind: 'superseded', epoch: oldEpoch },
        ],
        cursor: { position: oldPosition, epoch },
      },
    })
    expect(
      (await db.control(held.groupID, { groupID: held.groupID, incarnation: 1 }).load()).applied,
    ).toEqual([oldApplied])
    await source.consume(ref, held.groupID)
    const repeated = await openWelcome([source], firstWelcome)
    if (!('joined' in repeated)) throw new Error('Last-resort repeat must reach epoch admission')
    expect(
      judgeWelcomeAdmission({
        held: {
          incarnation: 1,
          epoch,
          deleted: false,
          forkHalted:
            (await db.control(held.groupID, { groupID: held.groupID, incarnation: 1 }).load())
              .forkHalt !== null,
        },
        spentEpochAuthenticators,
        welcome: {
          epoch: Number(repeated.joined.group.epoch),
          epochAuthenticator: repeated.joined.group.state.keySchedule.epochAuthenticator,
        },
      }),
    ).toBe('refused')
    expect(await db.loadState(held.groupID)).toEqual(encodeClientState(held.state))

    const leaf = group.findMemberLeafIndex(hub.identity.id)
    if (leaf == null) throw new Error('Missing invitee leaf')
    group = (await removeMember(group, leaf)).newGroup
    const other = randomIdentity()
    const otherBundle = await createKeyPackageBundle(other)
    group = (await commitInvite(group, otherBundle.publicPackage, await invite(other.id))).newGroup
    const laterInvite = await invite(hub.identity.id)
    const later = await commitInvite(group, bundle.publicPackage, laterInvite)
    group = later.newGroup
    const laterWelcome = {
      identity: hub.identity,
      invite: laterInvite,
      welcome: later.welcomeMessage,
      ratchetTree: group.state.ratchetTree,
    }
    const readmitted = await openWelcome([source], laterWelcome)
    if (!('joined' in readmitted)) throw new Error('Last-resort Welcome must reach re-admission')
    const joined = readmitted.joined.group
    expect(joined.groupID).toBe(held.groupID)
    expect(Number(joined.epoch)).toBe(epoch + 3)
    expect(
      judgeWelcomeAdmission({
        held: {
          incarnation: 1,
          epoch,
          deleted: false,
          forkHalted:
            (await db.control(held.groupID, { groupID: held.groupID, incarnation: 1 }).load())
              .forkHalt !== null,
        },
        spentEpochAuthenticators,
        welcome: {
          epoch: Number(joined.epoch),
          epochAuthenticator: joined.state.keySchedule.epochAuthenticator,
        },
      }),
    ).toBe('replace')
    await db.control(held.groupID, { groupID: held.groupID, incarnation: 1 }).apply(
      {
        putOperations: [
          {
            id: 'open-remove',
            kind: 'remove',
            revokes: true,
            body: new Uint8Array([1]),
            seq: 1,
            enqueuedAt: Date.now(),
            deadline: Date.now() + 30_000,
            stage: 'intent',
          },
        ],
        putWelcomes: [
          { opID: 'owed-invite', welcome: first.welcomeMessage, recipients: [other.id] },
        ],
      },
      'old-work',
    )
    await db
      .anchorStore(held.groupID)
      .save({ anchor: { epoch, secret: new Uint8Array(32).fill(1) } })
    const heldVersion = await db.loadVersion(joined.groupID)
    await db.seed(joined.groupID, encodeClientState(joined.state), {
      replace: true,
      expectedVersion: heldVersion,
    })
    spentEpochAuthenticators.push(joined.state.keySchedule.epochAuthenticator.slice())
    await source.consume(ref, joined.groupID)
    const stateBytes = await db.loadState(joined.groupID)
    const state = stateBytes == null ? undefined : decodeClientState(stateBytes)
    if (state == null) throw new Error('Missing replacement state')
    const restored = await restoreGroup({
      state,
      credential: joined.credential,
      ledgerEntries: joined.ledgerTokens,
    })
    expect(Number(restored.epoch)).toBe(epoch + 3)
    expect(restored.findMemberLeafIndex(hub.identity.id)).toBeDefined()
    const control = await db
      .control(joined.groupID, { groupID: joined.groupID, incarnation: 1 })
      .load()
    expect(control.operations).toEqual([])
    expect(control.applied).toEqual([])
    expect(control.responses).toEqual([])
    expect(control.cursor).toBeNull()
    expect(control.outcomes).toEqual([
      { id: 'open-remove', opID: 'open-remove', at: expect.any(Number), kind: 'unknown' },
    ])
    expect(control.welcomes).toEqual([
      { opID: 'owed-invite', welcome: first.welcomeMessage, recipients: [other.id] },
    ])
    expect(await db.anchorStore(joined.groupID).load()).toBeNull()
    expect(await source.receipt(ref)).toBeNull()
    expect((await store.list(hub.identity.id)).map(({ ref }) => ref)).toContain(ref)
    const again = await openWelcome([source], laterWelcome)
    if (!('joined' in again)) throw new Error('Last-resort repeat must reopen')
    expect(
      judgeWelcomeAdmission({
        held: {
          incarnation: 1,
          epoch: Number(restored.epoch),
          deleted: false,
          forkHalted:
            (await db.control(held.groupID, { groupID: held.groupID, incarnation: 1 }).load())
              .forkHalt !== null,
        },
        spentEpochAuthenticators,
        welcome: {
          epoch: Number(again.joined.group.epoch),
          epochAuthenticator: again.joined.group.state.keySchedule.epochAuthenticator,
        },
      }),
    ).toBe('refused')
  } finally {
    await hub.dispose()
  }
})

test('an unused older Welcome is alreadyJoined after removal and readmission', async () => {
  const hub = createTestHub()
  try {
    const source = createLastResortProvisioner({
      sourceID: 'fallback',
      identity: hub.identity,
      client: hub.client,
      store: createMemoryLastResortStore(),
    })
    await source.ensureProvisioned().value
    const [bundle] = await source.bundles()
    if (bundle == null) throw new Error('Missing last-resort bundle')
    const inviter = randomIdentity()
    const tokens = new Map<string, string>()
    const resolveLedgerEntries = async (ids: Array<string>) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error(`Missing ledger entry ${id}`)
        return token
      })
    let { group } = await createGroup(inviter, 'unused-welcome', { resolveLedgerEntries })
    const add = async (recipientDID: string, publicPackage: typeof bundle.publicPackage) => {
      const { invite } = await createInvite({
        group,
        identity: inviter,
        recipientDID,
        permission: 'member',
      })
      for (const token of invite.ledgerEntries) tokens.set(ledgerEntryDigest(token), token)
      const added = await commitInvite(group, publicPackage, invite)
      group = added.newGroup
      return {
        identity: hub.identity,
        invite,
        welcome: added.welcomeMessage,
        ratchetTree: group.state.ratchetTree,
      }
    }
    for (let index = 0; index < 2; index++) {
      const other = randomIdentity()
      await add(other.id, (await createKeyPackageBundle(other)).publicPackage)
    }
    // W3 is authenticated but never installed by this host.
    const w3 = await add(hub.identity.id, bundle.publicPackage)
    const unused = await openWelcome([source], w3)
    if (!('joined' in unused)) throw new Error('Expected unused Welcome to open')
    expect(Number(unused.joined.group.epoch)).toBe(3)
    const leaf = group.findMemberLeafIndex(hub.identity.id)
    if (leaf == null) throw new Error('Missing invitee leaf')
    group = (await removeMember(group, leaf)).newGroup
    expect(Number(group.epoch)).toBe(4)
    const w5 = await add(hub.identity.id, bundle.publicPackage)
    const installed = await openWelcome([source], w5)
    if (!('joined' in installed)) throw new Error('Expected readmission Welcome to open')
    expect(Number(installed.joined.group.epoch)).toBe(5)
    const db = createMemoryHostDatabase()
    await db.seed(installed.joined.group.groupID, encodeClientState(installed.joined.group.state))
    const spentEpochAuthenticators = [
      installed.joined.group.state.keySchedule.epochAuthenticator.slice(),
    ]
    const held = {
      incarnation: 1,
      epoch: 5,
      deleted: false,
      forkHalted:
        (
          await db
            .control(installed.joined.group.groupID, {
              groupID: installed.joined.group.groupID,
              incarnation: 1,
            })
            .load()
        ).forkHalt !== null,
    }
    expect(
      judgeWelcomeAdmission({
        held,
        spentEpochAuthenticators,
        welcome: {
          epoch: 3,
          epochAuthenticator: unused.joined.group.state.keySchedule.epochAuthenticator,
        },
      }),
    ).toBe('alreadyJoined')
    expect(
      judgeWelcomeAdmission({
        held,
        spentEpochAuthenticators,
        welcome: {
          epoch: 5,
          epochAuthenticator: installed.joined.group.state.keySchedule.epochAuthenticator.slice(),
        },
      }),
    ).toBe('refused')
  } finally {
    await hub.dispose()
  }
})
