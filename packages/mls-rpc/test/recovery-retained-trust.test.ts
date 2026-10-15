import type { OwnIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  createGroup,
  sealCapturedGroupInfo,
  sealRecoveryVerdict,
  verifyRecoveryRequest,
} from '@kumiai/mls'
import { expect, test } from 'vitest'

import * as recovery from '../src/recovery.js'
import { recoveryTrustFor } from '../src/registry/trust.js'

const lifecycle = (await import(
  new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  agent(byte: number): OwnIdentity
  bindingFor(identity: OwnIdentity): Promise<ControllerBinding>
}

async function fixture() {
  const identity = lifecycle.agent(43)
  const { group } = await createGroup(identity, 'retained-recovery', {
    controller: await lifecycle.bindingFor(identity),
  })
  const trust = recoveryTrustFor(group, { groupID: group.groupID, incarnation: 1 }, null)
  return { identity, group, trust }
}

test('retained trust requests are UTF-8 and captured replies authenticate without private state', async () => {
  const { identity, group, trust } = await fixture()
  const held = await recovery.createRecoveryRequestFromTrust({
    trust,
    identity,
    requestID: 'retained',
  })
  expect(held.request).toBeInstanceOf(Uint8Array)
  const request = new TextDecoder().decode(held.request)
  expect((await verifyRecoveryRequest(request)).requestID).toBe('retained')
  const sealed = await sealCapturedGroupInfo({ group, identity, request, captureHead: 'captured' })
  const params = { trust, sealed, requestID: 'retained', requestKey: held.requestKey, options: {} }
  const reply = await recovery.authenticateRecoveryReply(params)
  expect(reply?.captureHead).toBe('captured')
  expect(reply?.groupInfoAuthenticator).toEqual(group.state.keySchedule.epochAuthenticator)
  const verdict = {
    groupID: group.groupID,
    requestID: 'retained',
    position: 'position',
    commitDigest: 'commit',
    verdict: 'refused' as const,
    reason: 'policy' as const,
  }
  expect(
    await recovery.openRecoveryVerdictFromTrust({
      ...params,
      sealed: await sealRecoveryVerdict({ group, identity, request, verdict }),
    }),
  ).toEqual({ signer: identity.id, verdict })
  expect(
    await recovery.openRecoveryVerdictFromTrust({ ...params, sealed: new Uint8Array([0]) }),
  ).toBeNull()
})

for (const fault of ['provider', 'trusted-reader'] as const) {
  test(`retained verdict authentication preserves ${fault} errors`, async () => {
    const { identity, group, trust } = await fixture()
    const held = await recovery.createRecoveryRequestFromTrust({
      trust,
      identity,
      requestID: 'errors',
    })
    const sealed = await sealRecoveryVerdict({
      group,
      identity,
      request: new TextDecoder().decode(held.request),
      verdict: {
        groupID: group.groupID,
        requestID: 'errors',
        position: 'position',
        commitDigest: 'digest',
        verdict: 'superseded',
      },
    })
    const failure = new Error(`Retained ${fault} unavailable`)
    const params = { trust, sealed, requestID: 'errors', requestKey: held.requestKey, options: {} }
    if (fault === 'provider') {
      await expect(
        recovery.openRecoveryVerdictFromTrust({
          ...params,
          options: {
            cryptoProvider: {
              async getCiphersuiteImpl() {
                throw failure
              },
            },
          },
        }),
      ).rejects.toBe(failure)
    } else {
      await expect(
        recovery.openRecoveryVerdictFromTrust({
          ...params,
          trust: {
            ...trust,
            get registry(): typeof trust.registry {
              throw failure
            },
          },
        }),
      ).rejects.toBe(failure)
    }
  })
}

test('retained authentication refuses wrong group, anchor, binding, signer and floors', async () => {
  const { identity, group, trust } = await fixture()
  const held = await recovery.createRecoveryRequestFromTrust({
    trust,
    identity,
    requestID: 'checks',
  })
  const sealed = await sealCapturedGroupInfo({
    group,
    identity,
    request: new TextDecoder().decode(held.request),
    captureHead: null,
  })
  const params = { trust, sealed, requestID: 'checks', requestKey: held.requestKey, options: {} }
  const binding = trust.binding
  if (binding === null) throw new Error('Missing lifecycle binding')
  for (const changed of [
    { ...trust, groupID: 'other-group' },
    { ...trust, genesisAnchor: new Uint8Array() },
    { ...trust, binding: null },
    { ...trust, signerTree: [] },
    {
      ...trust,
      registry: {
        ...trust.registry,
        controllers: new Map([[binding.id, { recordedLog: [], genFloor: 100, timeFloor: 0 }]]),
      },
    },
  ]) {
    expect(await recovery.authenticateRecoveryReply({ ...params, trust: changed })).toBeNull()
  }
  expect(await recovery.authenticateRecoveryReply({ ...params, requestID: 'other' })).toBeNull()
})
