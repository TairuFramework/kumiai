import { type OwnIdentity, randomIdentity } from '@kokuin/token'
import {
  commitInvite,
  commitKeyRotation,
  createGroup,
  createInvite,
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  type GroupHandle,
  type GroupOptions,
  keyPackageRef,
  processWelcome,
} from '@kumiai/mls'
import { toB64U } from '@sozai/codec'

import type { PackageUse } from '../../src/persistence-types.js'
import { restoreMemoryControlHandle, seedMemoryControlState } from './sealed-memory-mls.js'

export async function registryHandle(params: {
  mode: 'real-mls' | 'double'
  handle: GroupHandle
  options: GroupOptions
}): Promise<GroupHandle> {
  if (params.mode === 'real-mls') return params.handle
  const { handle, options } = params
  const state = seedMemoryControlState(
    { ...handle.state, historicalReceiverData: new Map() },
    handle.credential,
    handle.ledgerTokens,
  )
  const model = JSON.parse(new TextDecoder().decode(state.confirmationTag))
  // A Welcome's admission identity remains the authenticated wire identity in both modes.
  model.epochIdentity = toB64U(handle.state.keySchedule.epochAuthenticator)
  state.confirmationTag = new TextEncoder().encode(JSON.stringify(model))
  state.keySchedule.epochAuthenticator = handle.state.keySchedule.epochAuthenticator.slice()
  state.keySchedule.resumptionPsk = state.keySchedule.epochAuthenticator.slice()
  return restoreMemoryControlHandle({
    state,
    credential: handle.credential,
    ledgerEntries: handle.ledgerTokens,
    options,
  })
}

export async function createRegistryWelcomeHistory(params: {
  mode: 'real-mls' | 'double'
  groupID: string
  identity: OwnIdentity
  options: GroupOptions
  kind: PackageUse['kind']
}) {
  const author = randomIdentity()
  const base = (await createGroup(author, params.groupID, params.options)).group
  const bundle = await (params.kind === 'last-resort'
    ? createLastResortKeyPackageBundle
    : createKeyPackageBundle)(params.identity, params.options)
  const { invite } = await createInvite({
    group: base,
    identity: author,
    recipientDID: params.identity.id,
    permission: 'member',
  })
  const retained: Array<{ handle: GroupHandle; join(): Promise<GroupHandle> }> = []
  async function at(epoch: number) {
    let source = base
    while (Number(source.epoch) < epoch) source = (await commitKeyRotation(source)).newGroup
    const added = await commitInvite(source, bundle.publicPackage, invite)
    const join = async () => {
      const { group } = await processWelcome({
        identity: params.identity,
        invite,
        welcome: added.welcomeMessage,
        keyPackageBundle: bundle,
        ratchetTree: added.newGroup.state.ratchetTree,
        options: params.options,
      })
      return registryHandle({ mode: params.mode, handle: group, options: params.options })
    }
    const handle = await join()
    retained.push({ handle, join })
    return handle
  }
  const unusedOlder = await at(0)
  const exact = await at(1)
  const alternate = await at(1)
  const newer = await at(2)
  return {
    history: {
      exact,
      alternate,
      newer,
      unusedOlder,
      packageUse: {
        sourceID: 'registry-welcome',
        ref: await keyPackageRef(bundle.publicPackage),
        kind: params.kind,
      },
    },
    retained,
  }
}
