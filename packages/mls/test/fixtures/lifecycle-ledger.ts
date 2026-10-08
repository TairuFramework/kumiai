import { now } from '@kokuin/capability'
import {
  createControllerIdentity,
  createInception,
  didFromInception,
  type SignedEvent,
} from '@kokuin/controller'
import { createFullIdentity, type OwnIdentity } from '@kokuin/token'
import { createCommit, defaultProposalTypes, encode, joinGroup, mlsMessageEncoder } from 'ts-mls'

import { mintLeafCapability, mintTrustedGrant } from '../../src/capability.js'
import type { ControllerBinding } from '../../src/credential.js'
import { encodeControlEnvelope } from '../../src/envelope.js'
import { commitWithEntries } from '../../src/group-commit.js'
import { resolveMlsContext } from '../../src/group-context.js'
import { createGroup } from '../../src/group-create.js'
import { createKeyPackageBundle } from '../../src/group-credential.js'
import { deriveGroup, GroupHandle } from '../../src/group-handle.js'
import { buildLedgerHeadExtension, extendHead, readLedgerHead } from '../../src/head.js'
import { ledgerEntryDigest } from '../../src/ledger.js'

export const controllerSeed = new Uint8Array(32).fill(31)
export const inception = createInception(controllerSeed, 0)
export const controllerID = didFromInception(inception.event)

export function agent(seedByte: number): OwnIdentity {
  const privateKey = new Uint8Array(32).fill(seedByte)
  return { ...createFullIdentity(privateKey), privateKey }
}

/** A delegating device and the trusted grant it holds. */
export type BindingIssuer = { identity: OwnIdentity; parent: string }

export async function bindingFor(
  identity: OwnIdentity,
  prefix: Array<SignedEvent> = [inception],
  issuer?: BindingIssuer,
): Promise<ControllerBinding> {
  const signer =
    issuer?.identity ?? createControllerIdentity({ seed: controllerSeed, profile: 0, log: prefix })
  const holderGrant = issuer == null ? undefined : await trustedGrant(identity, prefix)
  const capability = await mintLeafCapability({
    signer,
    controllerID,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: now() + 3600,
    ...(issuer == null ? {} : { parent: issuer.parent }),
  })
  return {
    id: controllerID,
    prefix,
    capability,
    ...(holderGrant == null ? {} : { holderGrant }),
  }
}

export async function trustedGrant(
  identity: OwnIdentity,
  prefix: Array<SignedEvent> = [inception],
) {
  return mintTrustedGrant({
    signer: createControllerIdentity({ seed: controllerSeed, profile: 0, log: prefix }),
    controllerID,
    audience: identity.id,
    leafKey: identity.publicKey,
    exp: now() + 7200,
  })
}

export async function lifecycleGroup(prefix: Array<SignedEvent> = [inception]) {
  const identity = agent(41)
  const tokens = new Map<string, string>()
  const { group } = await createGroup(identity, 'lifecycle-ledger', {
    controller: await bindingFor(identity, prefix),
    // Isolate ledger checks from the proposal rules supplied by the later consensus gate.
    commitPolicy: () => 'accept',
    resolveLedgerEntries: async (ids) =>
      ids.map((id) => {
        const token = tokens.get(id)
        if (token == null) throw new Error('Missing test token')
        return token
      }),
  })
  return { group, identity, tokens }
}

/** Exercise real Add and Welcome crypto without relying on the role-based invite API. */
export async function addMember(
  group: GroupHandle,
  identity: OwnIdentity,
  binding: ControllerBinding,
) {
  const bundle = await createKeyPackageBundle(identity, { controller: binding })
  const result = await createCommit({
    context: group.context,
    state: group.state,
    ratchetTreeExtension: true,
    extraProposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  if (result.welcome == null) throw new Error('Missing Welcome')
  const context = await resolveMlsContext()
  const joinedState = await joinGroup({
    context,
    welcome: result.welcome.welcome,
    keyPackage: bundle.publicPackage,
    privateKeys: bundle.privatePackage,
  })
  const joined = new GroupHandle({
    state: joinedState,
    context,
    credential: { id: identity.id, groupID: group.groupID },
    commitPolicy: group.commitPolicy,
    resolveLedgerEntries: group.resolveLedgerEntries,
  })
  await joined.bootstrapLedger(group.ledgerTokens)
  return { group: deriveGroup(group, result.newState), joined }
}

export async function enact(group: GroupHandle, tokens: Array<string>) {
  const result = await commitWithEntries({
    group,
    extraProposals: [],
    enacted: tokens,
    requireAdmin: false,
  })
  const derived = deriveGroup(group, result.newState)
  await derived.applyLedgerEntries(tokens)
  return { group: derived, message: encode(mlsMessageEncoder, result.commit) }
}

export function publish(tokens: Map<string, string>, entries: Array<string>) {
  for (const token of entries) tokens.set(ledgerEntryDigest(token), token)
}

/** Bypass the author gate to exercise hostile entry rejection on receive. */
export async function rawEnact(group: GroupHandle, tokens: Array<string>) {
  const head = readLedgerHead(group)
  if (head == null) throw new Error('Missing ledger head')
  const entries = tokens.map(ledgerEntryDigest)
  const extension = buildLedgerHeadExtension(extendHead(head.head, entries))
  const result = await createCommit({
    context: group.context,
    state: group.state,
    authenticatedData: encodeControlEnvelope({ v: 1, entries }),
    extraProposals: [
      {
        proposalType: defaultProposalTypes.group_context_extensions,
        groupContextExtensions: {
          extensions: group.state.groupContext.extensions.map((held) =>
            held.extensionType === extension.extensionType ? extension : held,
          ),
        },
      },
    ],
  })
  return encode(mlsMessageEncoder, result.commit)
}
