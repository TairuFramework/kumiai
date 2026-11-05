import { now } from '@kokuin/capability'
import {
  createControllerIdentity,
  createInception,
  createRotate,
  didFromInception,
  type SignedEvent,
  snapshotOf,
} from '@kokuin/controller'
import { nobleCrypto } from '@kokuin/crypto'
import type { CryptoOptions } from '@kokuin/token'
import { randomIdentity } from '@kokuin/token'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test, vi } from 'vitest'

import {
  createDIDAuthenticationService,
  verifyLeafCredential,
  verifyManagementCapability,
} from '../src/authentication.js'
import { mintLeafCapability, mintTrustedGrant, readCapability } from '../src/capability.js'
import { asControllerLog, foldChain, foldControllerLog } from '../src/controller-log.js'
import { LeafBindingError } from '../src/errors.js'
import { commitInvite, createInvite } from '../src/group-commit.js'
import { createMlsContext, resolveMlsContext } from '../src/group-context.js'
import { createGroup, restoreGroup } from '../src/group-create.js'
import { createKeyPackageBundle, makeMLSCredential } from '../src/group-credential.js'
import { publishControllerLog, revokeWithProof } from '../src/group-lifecycle.js'
import { processWelcome } from '../src/group-welcome.js'
import { signLedgerEntry, verifyLedgerEntry } from '../src/ledger.js'
import { authenticateLifecycleProof } from '../src/lifecycle-proof.js'
import {
  createRecoveryRequest,
  openSealedGroupInfo,
  RecoveryRequestError,
  sealGroupInfo,
  verifyRecoveryRequest,
} from '../src/recovery.js'
import { openRecoveryVerdict, sealRecoveryVerdict } from '../src/recovery-verdict.js'
import { DEVICE_ENTRY_TYPE, registrySeed } from '../src/registry.js'
import { ROLE_ENTRY_TYPE } from '../src/roster.js'
import { rotateChain } from './fixtures/controller-chain.js'
import {
  agent,
  bindingFor,
  controllerID,
  controllerSeed,
  inception,
  trustedGrant,
} from './fixtures/lifecycle-ledger.js'
import { buildManagementCapability } from './fixtures/management-capability.js'

type Provider = NonNullable<CryptoOptions['crypto']>

// Captured so a provider's own delegation is not counted by the spy on the default provider.
const nobleVerify = nobleCrypto.verify.bind(nobleCrypto)

/** Delegates to the default; `refuse` decides per signed message. Every instance has its own memo. */
function providerWith(refuse: (message: Uint8Array) => boolean) {
  const calls = { verify: 0 }
  const verdict = async (item: Parameters<Provider['verify']>[0]) => {
    calls.verify++
    return refuse(item.message) ? false : await nobleVerify(item)
  }
  const provider: Provider = {
    sign: (params) => nobleCrypto.sign(params),
    signBatch: (params) => nobleCrypto.signBatch(params),
    blake3: (params) => nobleCrypto.blake3(params),
    blake3Batch: (params) => nobleCrypto.blake3Batch(params),
    verify: verdict,
    verifyBatch: async (items) => await Promise.all(items.map(verdict)),
  }
  return { provider, calls }
}

const counting = () => providerWith(() => false)
const refusing = () => providerWith(() => true).provider

/** Refuses only the signature over one token, so everything else around it still verifies. */
function refusingToken(raw: string): Provider {
  const expected = fromUTF(readCapability(raw).data)
  return providerWith(
    (message) =>
      message.length === expected.length && message.every((byte, i) => byte === expected[i]),
  ).provider
}

/** Accepts until flipped; a signature first seen after the flip reaches the refusal. */
function switchable() {
  const state = { refuse: false }
  return { state, ...providerWith(() => state.refuse) }
}

describe('controller fold', () => {
  test('foldChain and foldControllerLog judge with the given provider', async () => {
    expect((await foldChain(controllerID, [inception])).ok).toBe(true)
    const { provider, calls } = counting()
    expect((await foldChain(controllerID, [inception], { crypto: provider })).ok).toBe(true)
    expect(calls.verify).toBeGreaterThan(0)
    expect((await foldChain(controllerID, [inception], { crypto: refusing() })).ok).toBe(false)
    expect(
      (await foldControllerLog(controllerID, asControllerLog([inception]), { crypto: refusing() }))
        .ok,
    ).toBe(false)
  })

  test('createGroup refuses a controller log its provider refuses', async () => {
    const identity = agent(81)
    const options = {
      controller: await bindingFor(identity),
      controllerLog: asControllerLog([inception]),
    }
    await expect(
      createGroup({ identity, groupID: 'fold-default', ...options }),
    ).resolves.toBeDefined()
    await expect(
      createGroup({ identity, groupID: 'fold-refused', ...options, crypto: refusing() }),
    ).rejects.toThrow()
  })
})

describe('ledger entry verification', () => {
  const entry = (groupID: string) => ({
    type: ROLE_ENTRY_TYPE,
    groupID,
    subject: 'did:key:z6MkSubject',
    value: 'member',
  })

  test('verifyLedgerEntry judges with the given provider', async () => {
    const token = await signLedgerEntry({ identity: randomIdentity(), entry: entry('ledger') })
    expect(await verifyLedgerEntry({ token })).not.toBeNull()
    expect(await verifyLedgerEntry({ token, crypto: refusing() })).toBeNull()
  })

  describe('when the provider fails', () => {
    const failure = new Error('Native crypto request failed: 4')

    function flakyProvider() {
      const state = { failing: true }
      const { provider } = counting()
      const flaky: Provider = {
        ...provider,
        verify: async (item) => {
          if (state.failing) throw failure
          return await provider.verify(item)
        },
        verifyBatch: async (items) => {
          if (state.failing) throw failure
          return await provider.verifyBatch(items)
        },
      }
      return { provider: flaky, state }
    }

    test('verifyLedgerEntry rejects instead of calling the token invalid', async () => {
      const identity = randomIdentity()
      const tokens = await Promise.all(
        ['one', 'two'].map((groupID) => signLedgerEntry(identity, entry(groupID))),
      )
      const { provider, state } = flakyProvider()
      await expect(verifyLedgerEntry(tokens[0] as string, { crypto: provider })).rejects.toBe(
        failure,
      )
      // Concurrent misses share one provider call.
      const settled = await Promise.allSettled(
        tokens.map((token) => verifyLedgerEntry(token, { crypto: provider })),
      )
      expect(settled).toEqual(tokens.map(() => ({ status: 'rejected', reason: failure })))
      state.failing = false
      expect(await verifyLedgerEntry(tokens[0] as string, { crypto: provider })).not.toBeNull()
    })

    test('applyLedgerEntries keeps an authentic entry through the failure', async () => {
      const identity = randomIdentity()
      const { group, credential } = await createGroup(identity, 'ledger-provider-failure')
      const token = await signLedgerEntry(identity, entry(group.groupID))
      const { provider, state } = flakyProvider()
      const restored = await restoreGroup({
        state: structuredClone(group.state),
        credential,
        options: { crypto: provider },
      })
      await expect(restored.applyLedgerEntries([token])).rejects.toBe(failure)
      expect(restored.ledger).toEqual([])
      state.failing = false
      expect(await restored.applyLedgerEntries([token])).toHaveLength(1)
      expect(restored.ledgerTokens).toEqual([token])
    })
  })

  test('a token another provider accepted is not reused from either ledger cache', async () => {
    const identity = randomIdentity()
    const { group, credential } = await createGroup({ identity, groupID: 'ledger-cache' })
    const token = await signLedgerEntry({ identity, entry: entry(group.groupID) })
    expect(await group.applyLedgerEntries([token])).toHaveLength(1)
    const exported = group.ledgerTokens
    expect(exported).toEqual([token])

    const restore = async (crypto?: Provider) =>
      await restoreGroup({
        state: structuredClone(group.state),
        credential,
        options: { crypto },
      })
    const refused = await restore(refusing())
    expect(await refused.applyLedgerEntries([token])).toEqual([])
    expect(await refused.applyLedgerEntries(exported)).toEqual([])
    expect(refused.ledger).toEqual([])

    // The same inputs through a default handle, or the check above proves nothing.
    expect(await (await restore()).applyLedgerEntries(exported)).toHaveLength(1)
  })
})

describe('capability check', () => {
  const manager = agent(82)

  test('a management capability is refused on the token signature alone', async () => {
    const cap = await buildManagementCapability({
      managerDID: manager.id,
      managerKey: manager.publicKey,
    })
    const params = {
      capability: cap.capability,
      prefix: cap.prefix,
      controllerID: cap.controllerID,
      audience: manager.id,
      leafKey: manager.publicKey,
    }
    expect(await verifyManagementCapability(params)).toBe(true)
    const crypto = refusingToken(cap.capability)
    // Only the token is refused: the chain still folds, so the false below is verifyToken's.
    expect((await foldChain(cap.controllerID, cap.prefix, { crypto })).ok).toBe(true)
    expect(await verifyManagementCapability({ ...params, crypto })).toBe(false)
    expect(await verifyManagementCapability({ ...params, crypto: refusing() })).toBe(false)
  })
})

describe('leaf authentication', () => {
  const leaf = agent(83)

  test('verifyLeafCredential judges a direct capability with the given provider', async () => {
    const binding = await bindingFor(leaf)
    const credential = makeMLSCredential({ identity: leaf, controller: binding })
    await expect(verifyLeafCredential(credential, leaf.publicKey)).resolves.toBeUndefined()
    await expect(
      verifyLeafCredential(credential, leaf.publicKey, {
        crypto: refusingToken(binding.capability as string),
      }),
    ).rejects.toHaveProperty('reason', 'signature-invalid')
    await expect(
      verifyLeafCredential(credential, leaf.publicKey, { crypto: refusing() }),
    ).rejects.toHaveProperty('reason', 'controller-mismatch')
  })

  test('the delegated signature check uses the given provider', async () => {
    const issuer = agent(84)
    const binding = await bindingFor(leaf, [inception], {
      identity: issuer,
      parent: await trustedGrant(issuer),
    })
    const credential = makeMLSCredential({ identity: leaf, controller: binding })
    await expect(verifyLeafCredential(credential, leaf.publicKey)).resolves.toBeUndefined()
    // The child token's signature is checked by the raw verifier, not verifyToken.
    await expect(
      verifyLeafCredential(credential, leaf.publicKey, {
        crypto: refusingToken(binding.capability as string),
      }),
    ).rejects.toHaveProperty('reason', 'signature-invalid')
  })

  test('the delegated parent grant is checked with the given provider', async () => {
    const issuer = agent(85)
    const parent = await trustedGrant(issuer)
    const binding = await bindingFor(leaf, [inception], { identity: issuer, parent })
    const credential = makeMLSCredential({ identity: leaf, controller: binding })
    await expect(
      verifyLeafCredential(credential, leaf.publicKey, { crypto: refusingToken(parent) }),
    ).rejects.toHaveProperty('reason', 'signature-invalid')
    // The structural stage skips checkCapability, so only the direct parent check can refuse here.
    await expect(
      verifyLeafCredential(credential, leaf.publicKey, {
        crypto: refusingToken(parent),
        judging: () => ({ stage: 'structural', mode: 'rejudge' }),
      }),
    ).rejects.toHaveProperty('reason', 'signature-invalid')
  })

  test('the authentication services of a context and of deps use the provider', async () => {
    const credential = makeMLSCredential({ identity: leaf, controller: await bindingFor(leaf) })
    const validate = async (service: {
      validateCredential: ReturnType<typeof createDIDAuthenticationService>['validateCredential']
    }) => await service.validateCredential(credential, leaf.publicKey)
    expect(await validate(createDIDAuthenticationService())).toBe(true)
    expect(await validate(createDIDAuthenticationService({ crypto: refusing() }))).toBe(false)

    const { cipherSuite, authService } = await resolveMlsContext()
    expect(await validate(authService)).toBe(true)
    expect(
      await validate(createMlsContext(cipherSuite, undefined, undefined, {}).authService),
    ).toBe(true)
    expect(
      await validate(
        createMlsContext(cipherSuite, undefined, undefined, { crypto: refusing() }).authService,
      ),
    ).toBe(false)
    expect(await validate((await resolveMlsContext({ crypto: refusing() })).authService)).toBe(
      false,
    )
  })

  test('createKeyPackageBundle refuses its own leaf under a refusing provider', async () => {
    const options = { controller: await bindingFor(leaf) }
    await expect(createKeyPackageBundle({ identity: leaf, ...options })).resolves.toBeDefined()
    await expect(
      createKeyPackageBundle({ identity: leaf, ...options, crypto: refusing() }),
    ).rejects.toBeInstanceOf(LeafBindingError)
  })
})

describe('lifecycle proof', () => {
  const seedEntry = () => ({
    issuer: agent(86).id,
    entry: {
      type: DEVICE_ENTRY_TYPE,
      groupID: 'lifecycle',
      subject: controllerID,
      value: { op: 'seed' as const, proof: asControllerLog([inception]) },
    },
  })

  test('authenticateLifecycleProof judges with the given provider', async () => {
    await expect(
      authenticateLifecycleProof(controllerID, seedEntry(), registrySeed()),
    ).resolves.toBeDefined()
    await expect(
      authenticateLifecycleProof(controllerID, seedEntry(), registrySeed(), {
        crypto: refusing(),
      }),
    ).rejects.toHaveProperty('reason', 'not-authority-signed')
  })

  test('a handle judges a fresh controller log with its own provider, and passes it on', async () => {
    const run = async (refuse: boolean) => {
      const identity = agent(87)
      const { state, provider } = switchable()
      const { group } = await createGroup({
        identity,
        groupID: `lifecycle-handle-${refuse}`,
        controller: await bindingFor(identity),
        controllerLog: asControllerLog([inception]),
        commitPolicy: () => 'accept',
        crypto: provider,
      })
      const rotation = await rotateChain({
        seed: controllerSeed,
        profile: 0,
        did: controllerID,
        chain: [inception],
      })
      state.refuse = refuse
      const published = await publishControllerLog({
        group,
        log: asControllerLog([inception, rotation]),
      })
      return { group, published, provider }
    }

    const accepted = await run(false)
    expect(accepted.group.crypto).toBe(accepted.provider)
    expect(accepted.group.clone().crypto).toBe(accepted.provider)
    expect(accepted.published?.newGroup.crypto).toBe(accepted.provider)
    await expect(run(true)).rejects.toHaveProperty('reason', 'not-authority-signed')
  })
})

describe('recovery', () => {
  test('a request is verified with the given provider, and the handle provider when sealing', async () => {
    const identity = randomIdentity()
    const { group } = await createGroup({ identity, groupID: 'recovery-request' })
    const held = await createRecoveryRequest({ group, identity, requestID: 'request' })
    await expect(verifyRecoveryRequest({ token: held.request })).resolves.toBeDefined()
    await expect(
      verifyRecoveryRequest({ token: held.request, crypto: refusing() }),
    ).rejects.toHaveProperty('reason', 'unverified')
    await expect(sealGroupInfo({ group, identity, request: held.request })).resolves.toBeDefined()

    const refused = await createGroup({ identity, groupID: 'recovery-request', crypto: refusing() })
    const request = await createRecoveryRequest({
      group: refused.group,
      identity,
      requestID: 'request',
    })
    await expect(
      sealGroupInfo({ group: refused.group, identity, request: request.request }),
    ).rejects.toThrow(RecoveryRequestError)
  })

  const sealedVerdict = async (refuse: boolean) => {
    const identity = randomIdentity()
    const { state, provider } = switchable()
    const { group } = await createGroup({
      identity,
      groupID: `recovery-verdict-${refuse}`,
      crypto: provider,
    })
    const held = await createRecoveryRequest({ group, identity, requestID: 'request' })
    const sealed = await sealRecoveryVerdict({
      group,
      identity,
      request: held.request,
      verdict: {
        groupID: group.groupID,
        requestID: 'request',
        position: 'position',
        commitDigest: 'digest',
        verdict: 'superseded',
      },
    })
    state.refuse = refuse
    return await openRecoveryVerdict({
      group,
      sealed,
      requestID: 'request',
      ephemeralPrivateKey: held.ephemeralPrivateKey,
    })
  }

  test('a verdict token is verified with the handle provider', async () => {
    await expect(sealedVerdict(false)).resolves.toMatchObject({
      verdict: { verdict: 'superseded' },
    })
    await expect(sealedVerdict(true)).rejects.toThrow()
  })

  const sealedAttestation = async (refuse: boolean) => {
    const identity = randomIdentity()
    const { state, provider } = switchable()
    const { group } = await createGroup({
      identity,
      groupID: `recovery-attestation-${refuse}`,
      crypto: provider,
    })
    const held = await createRecoveryRequest({ group, identity, requestID: 'request' })
    const sealed = await sealGroupInfo({ group, identity, request: held.request })
    state.refuse = refuse
    return await openSealedGroupInfo({
      group,
      sealed,
      requestID: 'request',
      ephemeralPrivateKey: held.ephemeralPrivateKey,
    })
  }

  test('a responder attestation is verified with the handle provider', async () => {
    await expect(sealedAttestation(false)).resolves.toBeInstanceOf(Uint8Array)
    await expect(sealedAttestation(true)).rejects.toThrow(
      'responder attestation signature did not verify',
    )
  })
})

describe('default provider', () => {
  /** Rotates over fresh signatures, so a site that dropped the provider misses the default memo. */
  async function rotation(
    seed: Uint8Array,
    did: string,
    chain: Array<SignedEvent>,
    crypto: Provider,
    deny: Array<string> = [],
  ) {
    const folded = await foldChain(did, chain, { crypto })
    if (!folded.ok) throw new Error(folded.reason)
    const head = folded.states.at(-1)
    const prior = chain.at(-1)
    if (head == null || prior == null) throw new Error('Missing controller head')
    const snapshot = snapshotOf({ state: head })
    return await createRotate({
      crypto,
      seed,
      profile: 0,
      did,
      prior: prior.event,
      snapshot: { ...snapshot, deny: [...snapshot.deny, ...deny] },
    })
  }

  test('a whole lifecycle under a provider verifies nothing with the default', async () => {
    const verify = vi.spyOn(nobleCrypto, 'verify')
    const verifyBatch = vi.spyOn(nobleCrypto, 'verifyBatch')
    const reached = () => verify.mock.calls.length + verifyBatch.mock.calls.length
    try {
      const { provider: crypto, calls } = counting()
      const seed = globalThis.crypto.getRandomValues(new Uint8Array(32))
      const first = await createInception({ crypto, seed, profile: 0 })
      const did = didFromInception(first.event)
      const signer = await createControllerIdentity({
        crypto,
        seed,
        profile: 0,
        log: asControllerLog([first]),
      })
      const grant = async (identity: ReturnType<typeof randomIdentity>) =>
        await mintTrustedGrant({
          signer,
          controllerID: did,
          audience: identity.id,
          leafKey: identity.publicKey,
          exp: now() + 7200,
        })

      const author = randomIdentity()
      const issuer = randomIdentity()
      const joiner = randomIdentity()
      const tokens = new Map<string, string>()
      const shared = {
        crypto,
        commitPolicy: () => 'accept' as const,
        resolveLedgerEntries: async (ids: Array<string>) => ids.map((id) => tokens.get(id) ?? ''),
      }
      const { group } = await createGroup({
        identity: author,
        groupID: 'default-provider',
        ...shared,
        controller: {
          id: did,
          prefix: [first],
          capability: await mintLeafCapability({
            signer,
            controllerID: did,
            audience: author.id,
            leafKey: author.publicKey,
            exp: now() + 3600,
          }),
        },
        controllerLog: asControllerLog([first]),
      })

      // A delegated leaf: raw signature check, parent token, capability walk and holder grant.
      const bundle = await createKeyPackageBundle({
        identity: joiner,
        crypto,
        controller: {
          id: did,
          prefix: [first],
          capability: await mintLeafCapability({
            signer: issuer,
            controllerID: did,
            audience: joiner.id,
            leafKey: joiner.publicKey,
            exp: now() + 3600,
            parent: await grant(issuer),
          }),
          holderGrant: await grant(joiner),
        },
      })
      const { invite } = await createInvite({
        group,
        identity: author,
        recipientDID: joiner.id,
      })
      const added = await commitInvite({ group, keyPackage: bundle.publicPackage, invite })
      const joined = await processWelcome({
        identity: joiner,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        options: shared,
      })
      const remember = (handle: typeof group) => {
        for (const held of handle.ledger) tokens.set(held.entryID, held.token)
      }

      const settled = await rotation(seed, did, [first], crypto)
      const published = await publishControllerLog({
        group: added.newGroup,
        log: asControllerLog([first, settled]),
      })
      if (published == null) throw new Error('Missing log commit')
      remember(published.newGroup)
      await joined.group.processMessage({ message: published.commitMessage })

      const target = randomIdentity().id
      const denied = await rotation(seed, did, [first, settled], crypto, [target])
      const built = await revokeWithProof(published.newGroup, {
        log: asControllerLog([first, settled, denied]),
        deny: [target],
      })
      if (built.status !== 'built') throw new Error(`Revoke not built: ${built.status}`)
      remember(built.result.newGroup)
      await joined.group.processMessage({ message: built.result.commitMessage })

      const live = built.result.newGroup
      const held = await createRecoveryRequest({
        group: joined.group,
        identity: joiner,
        requestID: 'request',
      })
      const sealed = await sealRecoveryVerdict({
        group: live,
        identity: author,
        request: held.request,
        verdict: {
          groupID: live.groupID,
          requestID: 'request',
          position: 'position',
          commitDigest: 'digest',
          verdict: 'superseded',
        },
      })
      await expect(
        openRecoveryVerdict({
          group: joined.group,
          sealed,
          requestID: 'request',
          ephemeralPrivateKey: held.ephemeralPrivateKey,
        }),
      ).resolves.toMatchObject({ signer: author.id })
      await expect(
        openSealedGroupInfo({
          group: joined.group,
          sealed: await sealGroupInfo({ group: live, identity: author, request: held.request }),
          requestID: 'request',
          ephemeralPrivateKey: held.ephemeralPrivateKey,
        }),
      ).resolves.toBeInstanceOf(Uint8Array)

      expect(calls.verify).toBeGreaterThan(0)
      expect(reached()).toBe(0)

      // An unexercised instrument would pass the line above.
      expect((await foldChain(did, [first])).ok).toBe(true)
      expect(reached()).toBeGreaterThan(0)
    } finally {
      verify.mockRestore()
      verifyBatch.mockRestore()
    }
  })
})
