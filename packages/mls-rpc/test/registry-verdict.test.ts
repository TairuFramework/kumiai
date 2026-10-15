import { normalizeDID, type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  type ControllerBinding,
  commitInvite,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  encodeClientState,
  type GroupHandle,
  parseMLSCredentialIdentity,
  processWelcome,
  type RecoveryVerdict,
  readGroupAnchorExtension,
} from '@kumiai/mls'
import { asLogPosition, type CapturedRejoinRecord } from '@kumiai/rpc'
import { describe, expect, test } from 'vitest'

import type { RegistryResyncRefusedError } from '../src/persistence-errors.js'
import { decodeRecoveryCandidate, encodeRecoveryCandidate } from '../src/recovery-codec.js'
import { recoveryTrustDigest } from '../src/recovery-trust-digest.js'
import { registryOptions } from '../src/registry/validation.js'
import { verifyRegistryResync } from '../src/registry/verdict.js'
import { createRegistryRecovery } from './fixtures/registry-recovery.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'

const lifecycle = (await import(
  new URL('../../mls/test/fixtures/lifecycle-ledger.ts', import.meta.url).href
)) as {
  bindingFor(
    identity: OwnIdentity,
    prefix?: ControllerBinding['prefix'],
    issuer?: { identity: OwnIdentity; parent: string },
  ): Promise<ControllerBinding>
  trustedGrant(identity: OwnIdentity): Promise<string>
}

async function setup(mode: 'real-mls' | 'double', bound = true) {
  const identity = randomIdentity()
  const signer = randomIdentity()
  const controller = bound ? await lifecycle.bindingFor(identity) : undefined
  const options = registryOptions({ ...(controller == null ? {} : { controller }) })
  let source = (await createGroup(identity, 'registry-verdict', options)).group
  let responder: { identity: OwnIdentity; group: GroupHandle } | undefined
  if (bound) {
    // A chained signer exercises retained revocation of its capability issuer as well.
    const binding = await lifecycle.bindingFor(signer, undefined, {
      identity,
      parent: await lifecycle.trustedGrant(identity),
    })
    const bundle = await createKeyPackageBundle(signer, { controller: binding })
    const { invite } = await createInvite({ group: source, identity, recipientDID: signer.id })
    const added = await commitInvite(source, bundle.publicPackage, invite)
    source = added.newGroup
    responder = {
      identity: signer,
      group: (
        await processWelcome({
          identity: signer,
          invite,
          welcome: added.welcomeMessage,
          keyPackageBundle: bundle,
          options,
        })
      ).group,
    }
  }
  source = await registryHandle({ mode, handle: source, options })
  if (responder != null)
    responder.group = await registryHandle({ mode, handle: responder.group, options })
  const fixture = await createRegistryRecovery({
    mode,
    identity,
    options,
    source,
    sourceKey: { groupID: source.groupID, incarnation: 1 },
    responder,
  })
  return { ...fixture, identity, signer, handle: source, options }
}

type Fixture = Awaited<ReturnType<typeof setup>>

async function refuses(s: Fixture, reason: RegistryResyncRefusedError['reason']) {
  await expect(verifyRegistryResync(s)).rejects.toMatchObject({
    name: 'RegistryResyncRefusedError',
    reason,
  })
}

function rewrite(
  s: Fixture,
  change: (snapshot: ReturnType<typeof decodeRecoveryCandidate>) => void,
) {
  const snapshot = decodeRecoveryCandidate(s.record.candidate, s.record.requestKey)
  change(snapshot)
  s.record.candidate = encodeRecoveryCandidate(snapshot, s.record.requestKey)
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(mode, () => {
    test('captured format refuses before legacy source and candidate decoding', async () => {
      const s = await setup(mode)
      const { source: _source, conflictEpoch: _conflict, ...common } = s.record
      const record: CapturedRejoinRecord = {
        ...common,
        format: 2,
        source: { ...s.source, identity: null, trustDigest: recoveryTrustDigest(s.source.trust) },
        target: {
          targetID: s.proof.targetID,
          topicID: s.proof.topicID,
          groupInfoEpoch: s.proof.groupInfoEpoch,
          groupInfoAuthenticator: s.source.trust.installed.authenticator.slice(),
          captureHead: s.proof.captureHead,
        },
        captureHead: s.proof.captureHead,
        searchFrom: s.proof.captureHead,
        trigger: 'automatic',
        authorisationID: null,
        switchMutationID: 'saved-switch',
        destinationKey: null,
        candidate: new Uint8Array([3]),
      }
      const before = structuredClone(record)
      await expect(verifyRegistryResync({ ...s, record })).rejects.toMatchObject({
        name: 'RegistryResyncRefusedError',
        reason: 'unaccepted',
      })
      expect(record).toEqual(before)
    })

    test('full bound confirmed verdict accepts', async () => {
      const s = await setup(mode)
      const before = encodeClientState(s.candidate.state)
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
      expect(encodeClientState(s.candidate.state)).toEqual(before)
      expect(s.source.trust.installed.epoch).toBe(s.record.source.epoch)
      expect(s.source.trust.installed.authenticator).toEqual(s.record.source.authenticator)
    })

    test.each(['signer', 'capability issuer', 'generation floor', 'lapsed grant'] as const)(
      'bound signer policy refuses retained %s',
      async (policy) => {
        const s = await setup(mode)
        const controller = s.candidate.anchor.controller
        if (controller == null) throw new Error('Missing bound controller')
        if (policy === 'signer' || policy === 'capability issuer') {
          const did = policy === 'signer' ? s.signer.id : s.identity.id
          s.source.trust.registry.devices = new Map(s.source.trust.registry.devices).set(
            normalizeDID(did),
            { controller, status: 'revoked' },
          )
        } else {
          s.source.trust.registry.controllers = new Map(s.source.trust.registry.controllers).set(
            normalizeDID(controller),
            {
              recordedLog: [],
              genFloor: policy === 'generation floor' ? 1 : 0,
              timeFloor: policy === 'lapsed grant' ? Date.now() / 1000 + 100_000 : 0,
            },
          )
        }
        await refuses(s, 'ineligible')
      },
    )

    test('bound signer policy refuses wrong controller', async () => {
      const s = await setup(mode)
      const leaf = s.candidate.state.ratchetTree.find((node) => {
        if (node?.nodeType !== 1 || !('identity' in node.leaf.credential)) return false
        return (
          normalizeDID(parseMLSCredentialIdentity(node.leaf.credential.identity).id) ===
          normalizeDID(s.signer.id)
        )
      })
      if (leaf?.nodeType !== 1 || !('identity' in leaf.leaf.credential))
        throw new Error('Missing signer')
      const credential = parseMLSCredentialIdentity(leaf.leaf.credential.identity)
      if (credential.controller == null) throw new Error('Missing controller')
      credential.controller.id = s.identity.id
      leaf.leaf.credential.identity = new TextEncoder().encode(JSON.stringify(credential))
      rewrite(s, (snapshot) => {
        snapshot.state = s.candidate.state
      })
      await refuses(s, 'ineligible')
    })

    test('cached anchor cannot bypass retained revoked signer', async () => {
      const s = await setup(mode)
      const controller = s.candidate.anchor.controller
      if (controller == null) throw new Error('Missing bound controller')
      s.source.trust.registry.devices = new Map(s.source.trust.registry.devices).set(
        normalizeDID(s.signer.id),
        { controller, status: 'revoked' },
      )
      await refuses(s, 'ineligible')
      const before = encodeClientState(s.candidate.state)
      delete s.candidate.anchor.controller
      expect(encodeClientState(s.candidate.state)).toEqual(before)
      expect(readGroupAnchorExtension(s.candidate)?.extensionData).toEqual(
        s.source.trust.genesisAnchor,
      )
      await refuses(s, 'candidate')
    })

    test.each([
      'creatorDID',
      'version',
      'controller',
      'leafLifetime',
      'trustedGrantLifetime',
      'app',
    ] as const)('cached anchor association refuses changed %s', async (field) => {
      const s = await setup(mode)
      const anchor = s.candidate.anchor
      if (field === 'creatorDID') anchor.creatorDID = s.signer.id
      if (field === 'version') anchor.version += 1
      if (field === 'controller') anchor.controller = s.signer.id
      if (field === 'leafLifetime') anchor.leafLifetime = (anchor.leafLifetime ?? 86_400) + 1
      if (field === 'trustedGrantLifetime')
        anchor.trustedGrantLifetime = (anchor.trustedGrantLifetime ?? 2_592_000) + 1
      if (field === 'app') anchor.app = { changed: true }
      await refuses(s, 'candidate')
    })

    test.each([
      ['request', { requestID: 'another-request' }, 'malformed'],
      ['group', { groupID: 'another-group' }, 'malformed'],
      ['epoch', { epoch: 1000 }, 'tuple'],
      ['position', { position: 'another-position' }, 'tuple'],
      ['digest', { commitDigest: 'another-digest' }, 'tuple'],
      ['tag', { tag: 'another-tag' }, 'tuple'],
      ['refused', { verdict: 'refused', reason: 'policy' }, 'unaccepted'],
      ['superseded', { verdict: 'superseded' }, 'unaccepted'],
    ] as const)('tuple and sealed record association refuse %s', async (_name, verdict, reason) => {
      const s = await setup(mode)
      const sealed = await s.sealVerdict({ verdict: verdict as Partial<RecoveryVerdict> })
      s.record.verdict = sealed
      s.proof.verdict = sealed
      await refuses(s, reason)
    })

    test.each(['own signer', 'signature', 'type', 'record bytes'] as const)(
      'tuple and sealed record association refuse %s',
      async (fault) => {
        const s = await setup(mode)
        const sealed = await s.sealVerdict({
          ...(fault === 'own signer' ? { identity: s.identity } : {}),
          ...(fault === 'signature' ? { tamperSignature: true } : {}),
          ...(fault === 'type' ? { type: 'kumiai.other' } : {}),
        })
        s.proof.verdict = sealed
        if (fault !== 'record bytes') s.record.verdict = sealed
        await refuses(s, fault === 'own signer' || fault === 'record bytes' ? 'tuple' : 'malformed')
      },
    )

    test.each(['built', 'published', 'refused', 'adopted'] as const)(
      'record source and candidate must match: stage %s',
      async (stage) => {
        const s = await setup(mode)
        s.record.stage = stage
        await refuses(s, 'unaccepted')
      },
    )

    test.each([
      'record incarnation',
      'source incarnation',
      'source epoch',
      'source authenticator',
      'installed identity',
      'tree',
      'credential',
      'binding',
      'ledger',
    ] as const)('record source and candidate must match: %s', async (fault) => {
      const s = await setup(mode)
      if (s.source.identity == null) throw new Error('Missing source identity')
      if (fault === 'record incarnation') s.record.source.key.incarnation += 1
      if (fault === 'source incarnation') s.source.key.incarnation += 1
      if (fault === 'source epoch') s.source.identity.epoch += 1
      if (fault === 'source authenticator') s.source.identity.authenticator.fill(0)
      if (fault === 'installed identity') s.source.trust.installed.authenticator.fill(0)
      if (fault === 'tree') s.source.trust.signerTree.pop()
      if (fault === 'credential') s.source.trust.credential.id = s.signer.id
      if (fault === 'binding') s.source.trust.binding = null
      if (fault === 'ledger') s.record.ledgerBefore = ['unrelated-ledger']
      await refuses(s, 'source')
    })

    test.each([
      'requestKey',
      'candidate',
      'requestID',
      'epochAfter',
      'private state',
      'own credential',
      'anchor',
      'bound tuple',
      'bound tag',
      'commit',
      'payload',
      'proof position',
      'proof digest',
    ] as const)('record source and candidate must match: %s', async (fault) => {
      const s = await setup(mode)
      if (fault === 'requestKey') s.record.requestKey = new Uint8Array(32)
      if (fault === 'candidate') s.record.candidate = (await setup(mode)).record.candidate
      if (fault === 'requestID')
        rewrite(s, (snapshot) => {
          snapshot.requestID = 'another-request'
        })
      if (fault === 'epochAfter') s.record.epochAfter += 1
      if (fault === 'private state')
        rewrite(s, (snapshot) => {
          snapshot.state.keySchedule.exporterSecret.fill(0)
        })
      if (fault === 'own credential') s.candidate.credential.id = s.signer.id
      if (fault === 'anchor') s.source.trust.genesisAnchor.fill(0)
      if (fault === 'bound tuple')
        rewrite(s, (snapshot) => {
          snapshot.boundCommit = { position: 'other', commitDigest: s.proof.payloadDigest }
        })
      if (fault === 'bound tag')
        rewrite(s, (snapshot) => {
          if (snapshot.boundCommit != null) snapshot.boundCommit.tag = 'wrong'
        })
      if (fault === 'commit') s.record.digest = 'unrelated-commit'
      if (fault === 'payload')
        s.record.payload[s.record.payload.length - 1] = (s.record.payload.at(-1) ?? 0) ^ 1
      if (fault === 'proof position') s.proof.position = asLogPosition('other-position')
      if (fault === 'proof digest') s.proof.payloadDigest = 'other-digest'
      await refuses(
        s,
        fault.startsWith('proof') || fault.startsWith('bound') ? 'tuple' : 'candidate',
      )
    })

    test('unbound confirmed retains existing judgment without a current membership rule', async () => {
      const s = await setup(mode, false)
      const outsider = randomIdentity()
      const sealed = await s.sealVerdict({ identity: outsider })
      s.record.verdict = sealed
      s.proof.verdict = sealed
      expect(s.handle.findMemberLeafIndex(outsider.id)).toBeUndefined()
      expect(s.candidate.findMemberLeafIndex(outsider.id)).toBeUndefined()
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
    })

    test('source key association is independent of property order', async () => {
      const s = await setup(mode)
      s.source.key = { incarnation: s.source.key.incarnation, groupID: s.source.key.groupID }
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
    })

    test.each(['binding', 'prefix event'] as const)(
      'source binding association is independent of property order: %s',
      async (part) => {
        const s = await setup(mode)
        const binding = s.source.trust.binding
        if (binding == null) throw new Error('Missing retained binding')
        s.source.trust.binding =
          part === 'binding'
            ? {
                capability: binding.capability,
                prefix: binding.prefix,
                id: binding.id,
                ...(binding.holderGrant == null ? {} : { holderGrant: binding.holderGrant }),
              }
            : {
                ...binding,
                prefix: binding.prefix.map((entry) => ({
                  ...Object.fromEntries(Object.entries(entry).reverse()),
                  event: Object.fromEntries(Object.entries(entry.event).reverse()),
                })) as ControllerBinding['prefix'],
              }
        await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
      },
    )

    test('unbound confirmed does not require an own leaf in the retained source tree', async () => {
      const s = await setup(mode, false)
      const index = s.handle.state.privatePath.leafIndex * 2
      rewrite(s, (snapshot) => {
        const other = snapshot.state.ratchetTree.find((node) => {
          return (
            node?.nodeType === 1 &&
            'identity' in node.leaf.credential &&
            normalizeDID(parseMLSCredentialIdentity(node.leaf.credential.identity).id) !==
              normalizeDID(s.identity.id)
          )
        })
        if (other == null) throw new Error('Missing other public source leaf')
        s.source.trust.signerTree[index] = other
        snapshot.sourceTree[index] = other
      })
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
    })

    test('complete candidate state includes independently restored double state', async () => {
      const s = await setup(mode)
      if (mode === 'double') {
        const snapshot = decodeRecoveryCandidate(s.record.candidate, s.record.requestKey)
        s.candidate = await restoreMemoryControlHandle({
          state: snapshot.state,
          credential: s.candidate.credential,
          ledgerEntries: snapshot.replyLedger,
          options: s.options,
        })
      }
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
    })

    test.each([
      { targetID: 42 },
      { topicID: null },
      { groupInfoEpoch: -1 },
      { groupInfoEpoch: 0.5 },
      { captureHead: 42 },
      { captureHead: '' },
      { position: '' },
      { payloadDigest: '' },
      { verdict: 'not bytes' },
    ])('target and capture fields receive validation only: %j', async (fault) => {
      const s = await setup(mode)
      await expect(
        verifyRegistryResync({ ...s, proof: { ...s.proof, ...fault } as typeof s.proof }),
      ).rejects.toMatchObject({ reason: 'malformed' })
    })

    test('well typed target and capture values are not claimed to be authenticated', async () => {
      const s = await setup(mode)
      s.proof = {
        ...s.proof,
        targetID: 'other-target',
        topicID: 'other-topic',
        groupInfoEpoch: 999,
        captureHead: asLogPosition('another-head'),
      }
      await expect(verifyRegistryResync(s)).resolves.toBeUndefined()
    })
  })
}
