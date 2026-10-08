import { audienceConfirmation } from '@kokuin/capability'
import { createControllerIdentity, createInception } from '@kokuin/controller'
import { type OwnIdentity, randomIdentity, stringifyToken } from '@kokuin/token'
import { createGroup } from '@kumiai/mls'
import { createCommit, defaultProposalTypes, generateKeyPackageWithKey, nodeTypes } from 'ts-mls'

/** Create real Welcome ciphertext below the holder-evidence admission gate. */
export async function holderlessWelcome() {
  const seed = new Uint8Array(32).fill(43)
  const inception = createInception(seed, 0)
  const controller = createControllerIdentity({ seed, profile: 0, log: [inception] })
  const inviter = randomIdentity()
  const trusted = randomIdentity()
  const identity = randomIdentity()
  const now = Math.floor(Date.now() / 1000)
  const claims = (recipient: OwnIdentity) => ({
    sub: controller.id,
    aud: recipient.id,
    act: 'authenticate',
    res: 'kumiai/mls-leaf',
    cnf: audienceConfirmation({ alg: 'EdDSA', publicKey: recipient.publicKey }),
    iat: now,
    exp: now + 3600,
  })
  const { group } = await createGroup(inviter, 'group:holder-evidence', {
    controller: {
      id: controller.id,
      prefix: [inception],
      capability: stringifyToken(await controller.signToken(claims(inviter))),
    },
  })
  const parent = stringifyToken(await controller.signToken(claims(trusted)))
  const capability = stringifyToken(await trusted.signToken({ ...claims(identity), cap: parent }))
  const leaf = group.state.ratchetTree[0]
  if (leaf?.nodeType !== nodeTypes.leaf) throw new Error('Missing creator leaf')
  const bundle = await generateKeyPackageWithKey({
    credential: {
      credentialType: 1,
      identity: new TextEncoder().encode(
        JSON.stringify({
          id: identity.id,
          controller: { id: controller.id, prefix: [inception], capability },
        }),
      ),
    },
    signatureKeyPair: { signKey: identity.privateKey, publicKey: identity.publicKey },
    cipherSuite: group.context.cipherSuite,
    capabilities: leaf.leaf.capabilities,
  })
  const added = await createCommit({
    context: { ...group.context, authService: { validateCredential: async () => true } },
    state: structuredClone(group.state),
    extraProposals: [
      { proposalType: defaultProposalTypes.add, add: { keyPackage: bundle.publicPackage } },
    ],
    ratchetTreeExtension: true,
  })
  if (added.welcome == null) throw new Error('Missing Welcome')
  return {
    identity,
    bundle,
    welcome: added.welcome.welcome,
    invite: {
      groupID: group.groupID,
      inviterID: inviter.id,
      recipientDID: identity.id,
      ledgerEntries: group.ledgerTokens,
    },
  }
}
