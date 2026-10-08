import { audienceConfirmation } from '@kokuin/capability'
import {
  createControllerIdentity,
  createReset,
  createRotate,
  type SignedEvent,
} from '@kokuin/controller'
import { type OwnIdentity, stringifyToken } from '@kokuin/token'
import {
  createApplicationMessage,
  createCommit,
  createGroupInfoWithExternalPubAndRatchetTree,
  createUpdateProposal,
  type DefaultProposal,
  decode,
  defaultProposalTypes,
  encode,
  generateKeyPackageWithKey,
  joinGroup,
  joinGroupExternal,
  mlsMessageDecoder,
  mlsMessageEncoder,
  nodeTypes,
  processMessage,
  protocolVersions,
  wireformats,
} from 'ts-mls'

import { type ControllerBinding, parseMLSCredentialIdentity } from '../../src/credential.js'
import { encodeControlEnvelope } from '../../src/envelope.js'
import { resolveMlsContext } from '../../src/group-context.js'
import { createGroup } from '../../src/group-create.js'
import { makeMLSCredential } from '../../src/group-credential.js'
import { deriveGroup, GroupHandle } from '../../src/group-handle.js'
import { processWelcome } from '../../src/group-welcome.js'
import { buildLedgerHeadExtension, extendHead, readLedgerHead } from '../../src/head.js'
import { ledgerEntryDigest } from '../../src/ledger.js'
import { agent, controllerID, controllerSeed, inception } from './lifecycle-ledger.js'

export { agent, controllerID, inception }

export type TimedBindingParams = {
  identity: OwnIdentity
  iat: number
  exp: number
  parent?: string
  issuer?: OwnIdentity
  prefix?: Array<SignedEvent>
}

export async function timedBinding(params: TimedBindingParams): Promise<ControllerBinding> {
  const { identity, iat, exp } = params
  const prefix = params.prefix ?? [inception]
  const signer =
    params.issuer ?? createControllerIdentity({ seed: controllerSeed, profile: 0, log: prefix })
  return {
    id: controllerID,
    prefix,
    ...(params.parent == null
      ? {}
      : {
          holderGrant: (await timedBinding({ identity, iat, exp: iat + 1000, prefix })).capability,
        }),
    capability: stringifyToken(
      await signer.signToken({
        sub: controllerID,
        aud: identity.id,
        act: 'authenticate',
        res: 'kumiai/mls-leaf',
        cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: identity.publicKey }),
        iat,
        exp,
        ...(params.parent == null ? {} : { cap: params.parent }),
      }),
    ),
  }
}

export type PipelineGroupOptions = {
  leafLifetime?: number
  trustedGrantLifetime?: number
  /** Create a group with no lifecycle controller. */
  standard?: boolean
}

export async function pipelineGroup(options: PipelineGroupOptions = {}) {
  const identity = agent(41)
  const tokens = new Map<string, string>()
  const { group } = await createGroup(identity, 'lifecycle-pipeline', {
    ...(options.standard
      ? {}
      : { controller: await timedBinding({ identity, iat: 100, exp: 200 }) }),
    leafLifetime: options.leafLifetime,
    trustedGrantLifetime: options.trustedGrantLifetime,
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

export async function rawBundle(
  group: GroupHandle,
  identity: OwnIdentity,
  binding?: ControllerBinding,
) {
  return generateKeyPackageWithKey({
    credential: makeMLSCredential(identity, binding),
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: group.context.cipherSuite,
    capabilities:
      group.state.ratchetTree[0]?.nodeType === nodeTypes.leaf
        ? group.state.ratchetTree[0].leaf.capabilities
        : undefined,
  })
}

export type RawCommitParams = {
  group: GroupHandle
  proposals?: Array<DefaultProposal>
  /** Rebinds the committer's own leaf in the committed state. */
  binding?: ControllerBinding
  /** Ledger entries enacted through the control envelope and head move. */
  tokens?: Array<string>
}

export async function rawCommit(params: RawCommitParams) {
  const { group, proposals = [], binding, tokens = [] } = params
  const state = structuredClone(group.state)
  const extraProposals = [...proposals]
  if (binding != null) {
    const node =
      state.ratchetTree[
        state.groupActiveState.kind === 'active' ? state.privatePath.leafIndex * 2 : 0
      ]
    if (node?.nodeType !== nodeTypes.leaf) throw new Error('Missing own leaf')
    const credential = node.leaf.credential as { credentialType: number; identity: Uint8Array }
    node.leaf.credential = {
      credentialType: 1,
      identity: new TextEncoder().encode(
        JSON.stringify({ ...parseMLSCredentialIdentity(credential.identity), controller: binding }),
      ),
    }
  }
  let authenticatedData: Uint8Array | undefined
  if (tokens.length > 0) {
    const head = readLedgerHead(group)
    if (head == null) throw new Error('Missing ledger head')
    const ids = tokens.map(ledgerEntryDigest)
    const extension = buildLedgerHeadExtension(extendHead(head.head, ids))
    extraProposals.push({
      proposalType: defaultProposalTypes.group_context_extensions,
      groupContextExtensions: {
        extensions: group.state.groupContext.extensions.map((held) =>
          held.extensionType === extension.extensionType ? extension : held,
        ),
      },
    })
    authenticatedData = encodeControlEnvelope({ v: 1, entries: ids })
  }
  return createCommit({
    authenticatedData,
    context: { ...group.context, authService: { validateCredential: async () => true } },
    state,
    extraProposals,
    ratchetTreeExtension: true,
  })
}

export async function rawAdd(
  group: GroupHandle,
  identity: OwnIdentity,
  binding?: ControllerBinding,
) {
  const bundle = await rawBundle(group, identity, binding)
  const result = await rawCommit({
    group,
    proposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  return { bundle, result, message: encode(mlsMessageEncoder, result.commit) }
}

/** Real Welcome crypto bypassing only the public invite's role-entry requirement. */
export async function lowLevelWelcome(
  group: GroupHandle,
  identity: OwnIdentity,
  binding: ControllerBinding,
) {
  const added = await rawAdd(group, identity, binding)
  if (added.result.welcome == null) throw new Error('Missing Welcome')
  const context = await resolveMlsContext()
  const state = await joinGroup({
    context,
    welcome: added.result.welcome.welcome,
    keyPackage: added.bundle.publicPackage,
    privateKeys: added.bundle.privatePackage,
  })
  const joined = new GroupHandle({
    state,
    context,
    credential: { id: identity.id, groupID: group.groupID },
    commitPolicy: () => 'accept',
    resolveLedgerEntries: group.resolveLedgerEntries,
  })
  await joined.bootstrapLedger(group.ledgerTokens)
  return { ...added, joined, author: deriveGroup(group, added.result.newState) }
}

/** Real external resync carrying a caller-selected bound replacement. */
export type LowLevelExternalParams = {
  group: GroupHandle
  identity: OwnIdentity
  binding?: ControllerBinding
  /** Defaults to true. */
  resync?: boolean
}

export async function lowLevelExternal(params: LowLevelExternalParams) {
  const { group, identity, binding, resync = true } = params
  const context = await resolveMlsContext()
  const bundle = await rawBundle(group, identity, binding)
  const groupInfo = await createGroupInfoWithExternalPubAndRatchetTree(
    group.state,
    [],
    context.cipherSuite,
  )
  const result = await joinGroupExternal({
    context,
    groupInfo,
    keyPackage: bundle.publicPackage,
    privateKeys: bundle.privatePackage,
    resync,
  })
  return encode(mlsMessageEncoder, {
    version: protocolVersions.mls10,
    wireformat: wireformats.mls_public_message,
    publicMessage: result.publicMessage,
  })
}

export async function rawUpdate(
  group: GroupHandle,
  identity: OwnIdentity,
  binding?: ControllerBinding,
) {
  const state = structuredClone(group.state)
  const node = state.ratchetTree[state.privatePath.leafIndex * 2]
  if (node?.nodeType !== nodeTypes.leaf) throw new Error('Missing own leaf')
  node.leaf.credential = makeMLSCredential(identity, binding)
  state.signaturePrivateKey = identity.privateKey
  node.leaf.signaturePublicKey = identity.publicKey
  const result = await createUpdateProposal({ context: group.context, state })
  return encode(mlsMessageEncoder, result.message)
}

export async function rawApplication(group: GroupHandle) {
  const result = await createApplicationMessage({
    context: group.context,
    state: structuredClone(group.state),
    message: new TextEncoder().encode('delayed'),
  })
  return encode(mlsMessageEncoder, result.message)
}

/** Build a real Welcome while bypassing admission gates to exercise revalidation. */
export async function welcomeBoundary(
  group: GroupHandle,
  identity: OwnIdentity,
  binding: ControllerBinding,
) {
  const bundle = await rawBundle(group, identity, binding)
  const result = await rawCommit({
    group,
    proposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
  })
  if (result.welcome == null) throw new Error('Missing Welcome')
  const welcome = result.welcome.welcome
  return {
    process: () =>
      processWelcome({
        identity,
        invite: {
          groupID: group.groupID,
          inviterID: agent(41).id,
          recipientDID: identity.id,
          ledgerEntries: group.ledgerTokens,
        },
        welcome,
        keyPackageBundle: { ...bundle, ownerDID: identity.id },
      }),
  }
}

/** Apply a fixture's intentionally over-horizon epoch without the kumiai consensus gate. */
export async function lowLevelApply(group: GroupHandle, message: Uint8Array) {
  const decoded = decode(mlsMessageDecoder, message)
  if (
    decoded == null ||
    (decoded.wireformat !== wireformats.mls_private_message &&
      decoded.wireformat !== wireformats.mls_public_message)
  )
    throw new Error('Invalid fixture message')
  const result = await processMessage({
    context: group.context,
    state: group.state,
    message: decoded,
  })
  return deriveGroup(group, result.newState)
}

export async function oversizedBinding(identity: OwnIdentity, iat: number, exp: number) {
  const rotation = createRotate({
    seed: controllerSeed,
    profile: 0,
    did: controllerID,
    prior: inception.event,
    options: { keyPosition: { gen: 0, seq: 0 }, seal: 's'.repeat(393216) },
  })
  return timedBinding({ identity, iat, exp, prefix: [inception, rotation] })
}

export function resetPrefix(): Array<SignedEvent> {
  return [inception, createReset(controllerSeed, 0, 1)]
}
