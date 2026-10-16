import { sealCapturedGroupInfo } from '@kumiai/mls'
import { expect, test } from 'vitest'

import { createGroupMLS } from '../src/mls.js'
import { createRecoveryRequestFromTrust } from '../src/recovery.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import { capturedRecord } from './fixtures/captured-recovery.js'
import {
  createRealGroup,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'

async function setup() {
  const real = await createRealGroup(2, 'recovery-diagnostics')
  const member = real.members[0]
  const responder = real.members[1]
  if (member === undefined || responder === undefined) throw new Error('Missing members')
  const trust = recoveryTrustFor(
    member.handle,
    { groupID: member.handle.groupID, incarnation: 1 },
    null,
  )
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 1,
    lifetimeRevision: 1,
    identity: null,
    trust,
    trustDigest: recoveryTrustDigest(trust),
  }
  const dependencies = testGroupMLSDependencies(
    testHandleAccess({ handle: () => member.handle, adopt: async () => {} }),
  )
  const port = createGroupMLS({
    ...dependencies,
    identity: member.identity,
    entrySlot: member.slot,
    recoveryAdoption: {
      target: { targetID: 'hub', topicID: 'commits' },
      environment: { identity: member.identity, options: {} },
      readRecoverySource: async () => source,
      accept: async () => {},
    },
  })
  const captured = port.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured port')
  const held = await port.createRecoveryRequest('X')
  const sealed = await sealCapturedGroupInfo({
    group: responder.handle,
    identity: responder.identity,
    request: new TextDecoder().decode(held.request),
    captureHead: null,
  })
  const pending = await captured.applyRecovery(sealed, 'X', held.requestKey)
  if (pending === null || 'renewalRequired' in pending) throw new Error('Missing pending X')
  const record = capturedRecord(pending, held.request, held.requestKey, 'X')
  return { captured, record, member, responder, source, control: dependencies.control }
}

test.each(['below floor', 'same epoch disagreement', 'ineligible reply'] as const)(
  'target behind preserves exact active attempt without authority: %s',
  async (row) => {
    const s = await setup()
    await s.control.apply({ putRejoin: s.record }, 'save-X')
    const before = await s.control.load()
    const fresh = await createRecoveryRequestFromTrust({
      identity: s.member.identity,
      trust: s.source.trust,
      requestID: 'recapture',
    })
    if (row === 'same epoch disagreement')
      s.responder.handle.state.keySchedule.epochAuthenticator.fill(0)
    const sealed =
      row === 'ineligible reply'
        ? new Uint8Array([0])
        : await sealCapturedGroupInfo({
            group: s.responder.handle,
            identity: s.responder.identity,
            request: new TextDecoder().decode(fresh.request),
            captureHead: 'later-head',
          })
    expect(
      await s.captured.reconcileCapture(s.record, {
        sealed,
        requestID: 'recapture',
        requestKey: fresh.requestKey,
        epochFloor: row === 'below floor' ? s.record.target.groupInfoEpoch + 1 : null,
      }),
    ).toEqual(
      row === 'ineligible reply'
        ? { kind: 'retry' }
        : {
            kind: 'retry',
            reason: row === 'below floor' ? 'target-behind' : 'capture-authenticator-disagreement',
          },
    )
    expect(await s.control.load()).toEqual(before)
    expect((await s.control.load()).forkHalt).toBeNull()
  },
)
