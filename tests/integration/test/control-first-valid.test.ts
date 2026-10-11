import { randomIdentity } from '@kokuin/token'
import { commitInvite, createGroup, createInvite, createKeyPackageBundle } from '@kumiai/mls'
import {
  asLogPosition,
  CONTROL_SEARCH_BUDGET,
  createControlSearch,
  deliverObligations,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  HANDSHAKE_KIND,
  type Outcome,
  settleControlSlot,
} from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import {
  createDurableHandleAccess,
  createOperationHost,
  encodeJournal,
  operationIntent,
  operationRequest,
} from './app-lane-e2e.js'

test.each(['unknown', 'lost', 'abandon'] as const)(
  'real first-valid adoption of an orphaned %s invite co-commits and delivers its saved Welcome',
  async (prior) => {
    const identity = randomIdentity()
    const invitee = randomIdentity()
    let current = (await createGroup(identity, `first-valid-${prior}`)).group
    const access = createDurableHandleAccess({
      handle: () => current,
      adopt: (next) => {
        current = next
      },
    })
    const host = createOperationHost(access, identity)
    const { invite } = await createInvite({
      group: current,
      identity,
      recipientDID: invitee.id,
      permission: 'member',
    })
    const bundle = await createKeyPackageBundle(invitee)
    const committed = await commitInvite(current, bundle.publicPackage, invite)
    const op = operationIntent(operationRequest('invite', {}))
    const builds = vi.fn(async () => ({
      commit: committed.commitMessage,
      journal: encodeJournal(committed.newGroup),
      bodies: invite.ledgerEntries,
      welcome: { bytes: committed.welcomeMessage, recipients: [invitee.id] },
      epoch: Number(current.epoch),
      incarnation: 1,
      authenticatorBefore: current.state.keySchedule.epochAuthenticator.slice(),
      digest: digestAppliedCommit(committed.commitMessage),
    }))
    host.builders.set(op.id, builds)
    await host.control.apply({ putOperations: [op] }, 'enqueue')
    expect(
      (
        await host.prepareBuild(op, async (built, seal) => ({
          payload: encodeHandshakeFrame(
            HANDSHAKE_KIND.commit,
            encodeCommitFrame(built.commit, (await seal(encodeLedgerEntries(built.bodies))).sealed),
          ),
          publishID: 'retained-invite',
          expectedHead: null,
        }))
      ).kind,
    ).toBe('saved')
    const slot = (await host.control.load()).commitOnce
    if (slot === null) throw new Error('Missing slot')
    await host.control.apply(
      {
        deleteOperations: [op.id],
        putOutcomes: [
          {
            id: op.id,
            opID: op.id,
            at: op.deadline,
            kind: prior === 'abandon' ? 'unknown' : prior,
          },
        ],
      },
      'settle',
    )
    await host.control.apply({ deleteOutcomes: [op.id] }, 'ack')
    let missing = true
    const restore = host.validation.restoreValidation.bind(host.validation)
    const position = asLogPosition('00000000000000000001')
    const search = createControlSearch({
      budget: CONTROL_SEARCH_BUDGET,
      validation: {
        restoreValidation: (built) => (missing ? Promise.resolve(null) : restore(built)),
      },
      readEvidence: host.readEvidence,
      fetch: async (after) => ({
        head: position,
        oldest: position,
        gap: false,
        messages:
          after === position
            ? []
            : [
                {
                  topicID: 'control',
                  sequenceID: position,
                  senderDID: identity.id,
                  payload: slot.payload,
                },
              ],
      }),
      followWinner: async () => {
        throw new Error('Unexpected competitor')
      },
      reconcileAbsent: async () => true,
      hold: async (controlHold) => {
        await host.control.apply({ controlHold }, crypto.randomUUID())
      },
    })
    const emitted: Array<Outcome> = []
    const deps = {
      control: host.control,
      search,
      adoption: { adopt: host.adopt },
      readEvidence: host.readEvidence,
      now: () => op.deadline + 1,
      newID: () => crypto.randomUUID(),
      emit: (outcome: Outcome) => emitted.push(outcome),
    }
    expect(await settleControlSlot(deps)).toBe('unknown')
    expect((await host.control.load()).controlHold?.reason).toBe('acceptance-unknown')
    expect(current.epoch).toBe(BigInt(slot.epoch))
    const version = (await host.readEvidence()).source.stateVersion
    await access.mutate(async (handle) => {
      await handle.proposeSelfRemoval()
    })
    expect(Object.keys(current.state.unappliedProposals)).toHaveLength(1)
    expect((await host.readEvidence()).source.stateVersion).toBeGreaterThan(version)
    expect((await host.control.load()).commitOnce).toEqual(slot)
    missing = false
    expect(await settleControlSlot(deps)).toBe('landed')
    const saved = await host.control.load()
    expect(saved.operations).toEqual([])
    expect(saved.commitOnce).toBeNull()
    expect(saved.controlHold).toBeNull()
    expect(current.state.keySchedule.epochAuthenticator).toEqual(
      committed.newGroup.state.keySchedule.epochAuthenticator,
    )
    expect(saved.applied).toEqual([
      expect.objectContaining({ payloadDigest: slot.payloadDigest, sequenceID: position }),
    ])
    expect(saved.cursor).toEqual({ position, epoch: slot.epoch + 1 })
    expect(saved.outcomes).toEqual([
      expect.objectContaining({
        id: JSON.stringify(['control:landed', op.id, slot.publishID, position]),
        opID: op.id,
        kind: 'landed',
        position,
      }),
    ])
    expect(saved.welcomes).toEqual([
      { opID: op.id, welcome: committed.welcomeMessage, recipients: [invitee.id], committed: true },
    ])
    await deliverObligations(
      {
        control: host.control,
        canDeliver: async (owed) => owed.committed === true,
        deliverWelcome: host.deliverWelcome,
      },
      saved,
    )
    expect(host.welcomes).toEqual(saved.welcomes)
    await host.control.apply(
      { deleteOutcomes: saved.outcomes.map((outcome) => outcome.id) },
      'ack-landed',
    )
    expect(await settleControlSlot(deps)).toBe('empty')
    expect((await host.control.load()).outcomes).toEqual([])
    expect((await host.control.load()).welcomes).toEqual([])
    expect(builds).toHaveBeenCalledTimes(1)
    expect(emitted).toHaveLength(1)
  },
)
