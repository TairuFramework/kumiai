import { randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  renewLeaf,
  sealCapturedGroupInfo,
} from '@kumiai/mls'
import {
  type BuiltCommit,
  digestAppliedCommit,
  encodeCommitFrame,
  encodeHandshakeFrame,
  HANDSHAKE_KIND,
  type Operation,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'
import { expect, test, vi } from 'vitest'

import { encodeControlJournal } from '../src/control-journal.js'
import { createGroupMLS, createLedgerEntrySlot } from '../src/mls.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { recoveryTrustFor } from '../src/registry/trust.js'
import {
  loadLifecyclePipelineFixture,
  testGroupMLSDependencies,
  testHandleAccess,
} from './fixtures/real-group.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

test.each([
  'valid',
  'stale',
  'absent',
  'wrong-controller',
  'host-error',
  'provider-error',
  'replacement-provider-error',
] as const)(
  'candidate-free binding renewal inspects advancing recovery with a live build (%s)',
  async (replacement) => {
    const lifecycle = await loadLifecyclePipelineFixture()
    const identity = lifecycle.agent(63)
    const now = Math.floor(Date.now() / 1000)
    const cached = await lifecycle.timedBinding({ identity, iat: now - 20, exp: now + 1000 })
    const renewed = await lifecycle.timedBinding({ identity, iat: now - 10, exp: now + 1000 })
    let { group } = await createGroup(identity, 'inspection-renewal', {
      controllerLog: { chain: cached.prefix, events: [] },
      controller: cached,
    })
    const companion = lifecycle.agent(83)
    const bundle = await createKeyPackageBundle(companion, {
      controller: await lifecycle.timedBinding({
        identity: companion,
        iat: now - 20,
        exp: now + 1000,
      }),
    })
    const { invite } = await createInvite({ group, identity, recipientDID: companion.id })
    group = (await commitInvite(group, bundle.publicPackage, invite)).newGroup
    const advanced = (await renewLeaf(group, renewed)).newGroup
    const prepared = await commitKeyRotation(group)
    const store = createTransactionalStore(group)
    const access = testHandleAccess({
      handle: () => group,
      adopt: () => {
        throw new Error('inspection must not adopt')
      },
      stateVersion: () => store.snapshot().revision,
    })
    const source = await access.readControl(async ({ source }) => source)
    if (source.identity === null) throw new Error('Missing source identity')
    const payload = encodeHandshakeFrame(
      HANDSHAKE_KIND.commit,
      encodeCommitFrame(prepared.commitMessage, new Uint8Array()),
    )
    const intent: Operation = {
      id: 'live-build',
      kind: 'ledger',
      revokes: false,
      body: new Uint8Array(),
      seq: 1,
      enqueuedAt: Date.now(),
      deadline: Date.now() + 30_000,
      stage: 'intent',
    }
    const built: BuiltCommit = {
      opID: intent.id,
      kind: intent.kind,
      revokes: false,
      enqueuedAt: intent.enqueuedAt,
      deadline: intent.deadline,
      epoch: source.identity.epoch,
      incarnation: 1,
      authenticatorBefore: source.identity.authenticator,
      head: null,
      expectedHead: null,
      publishID: 'saved-build',
      payload,
      payloadDigest: toB64U(sha256(payload)),
      digest: digestAppliedCommit(prepared.commitMessage),
      bodies: [],
      welcome: null,
      journal: encodeControlJournal({
        version: 1,
        source,
        checkpoint: null,
        sourceState: encodeClientState(group.state),
        sourceCredential: group.credential,
        sourceLedger: group.ledgerTokens,
        candidate: encodeClientState(prepared.newGroup.state),
      }),
    }
    await store.control.apply({ putOperations: [intent] }, 'intent')
    expect(
      await store.saveBuilt(
        intent,
        built,
        { ...source, stateVersion: store.snapshot().revision },
        'build',
      ),
    ).toBe('saved')
    const failure = new Error('local renewal provider unavailable')
    const wrong = await createGroup(randomIdentity(), 'other-controller')
    let failProvider = false
    const host = vi.fn(async () => {
      if (replacement === 'host-error') throw failure
      if (replacement === 'stale') return cached
      if (replacement === 'absent') return null
      if (replacement === 'wrong-controller') return { ...renewed, id: wrong.group.credential.id }
      if (replacement === 'replacement-provider-error') failProvider = true
      return renewed
    })
    const suite = advanced.context.cipherSuite
    const options = {
      cryptoProvider: {
        async getCiphersuiteImpl() {
          if (failProvider) throw failure
          return suite
        },
      },
    }
    const port = createGroupMLS({
      identity,
      ...testGroupMLSDependencies(access, store.control),
      entrySlot: createLedgerEntrySlot(),
      recoveryAdoption: {
        target: { targetID: 'hub', topicID: 'topic' },
        environment: { identity, options, recoveryBinding: host },
        async readRecoverySource() {
          const trust = recoveryTrustFor(group, source.key, null)
          return {
            lifetimeRevision: 0,
            trustDigest: recoveryTrustDigest(trust),
            ...(await access.readControl(async ({ source }) => source)),
            trust,
          }
        },
        async accept() {
          throw new Error('inspection must not retire live work')
        },
      },
    })
    const captured = port.capturedRecovery
    if (captured === undefined) throw new Error('Missing captured recovery')
    const { request, requestKey } = await port.createRecoveryRequest('renewal')
    const sealed = await sealCapturedGroupInfo({
      group: advanced,
      identity,
      request: new TextDecoder().decode(request),
      captureHead: null,
    })
    expect(await port.prepareRecovery()).toBe('ready')
    expect(host).not.toHaveBeenCalled()
    const before = structuredClone(store.snapshot())
    const sign = vi
      .spyOn(suite.signature, 'sign')
      .mockRejectedValue(new Error('inspection must not sign'))
    const kem = vi
      .spyOn(suite.hpke, 'generateKeyPair')
      .mockRejectedValue(new Error('inspection must not generate keys'))
    try {
      failProvider = replacement === 'provider-error'
      const inspected = captured.inspectCapture({
        sealed,
        requestID: 'renewal',
        requestKey,
        epochFloor: null,
      })
      if (
        replacement === 'host-error' ||
        replacement === 'provider-error' ||
        replacement === 'replacement-provider-error'
      ) {
        await expect(inspected).rejects.toBe(failure)
      } else if (replacement === 'valid') {
        expect(await inspected).toEqual({
          groupID: group.groupID,
          epoch: Number(advanced.epoch),
          authenticator: advanced.state.keySchedule.epochAuthenticator,
        })
        expect(Number(advanced.epoch)).toBeGreaterThan(built.epoch)
      } else {
        expect(await inspected).toBeNull()
      }
      expect(host).toHaveBeenCalledTimes(replacement === 'provider-error' ? 0 : 1)
      if (replacement !== 'provider-error')
        expect(host).toHaveBeenCalledWith({
          groupID: group.groupID,
          controllerID: cached.id,
          current: cached,
        })
      expect(sign).not.toHaveBeenCalled()
      expect(kem).not.toHaveBeenCalled()
      expect(store.snapshot()).toEqual(before)
    } finally {
      sign.mockRestore()
      kem.mockRestore()
    }
    if (replacement === 'valid') {
      const pending = await captured.applyRecovery(sealed, 'renewal', requestKey)
      expect(pending).not.toBeNull()
      expect(pending).not.toHaveProperty('renewalRequired')
      if (pending === null || 'renewalRequired' in pending) throw new Error('Missing candidate')
      expect(pending.target.groupInfoEpoch).toBe(Number(advanced.epoch))
      expect(store.snapshot()).toEqual(before)
    }
  },
)
