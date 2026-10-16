import { decodeSignedToken, normalizeDID } from '@kokuin/token'
import {
  type ClientState,
  type DeviceRegistry,
  decodeGroupAnchor,
  type GroupAnchor,
  type PublicRuntimeFacts,
  parseMLSCredentialIdentity,
  publicMembershipFacts,
} from '@kumiai/mls'
import { controlSafetyHeld, type SendAdmission } from '@kumiai/rpc'

import type { AccountedGroupObservation } from '../entry-capability.js'
import { assertTrustTransition } from '../persistence-guards.js'
import type { GroupRecoveryTrust } from '../persistence-types.js'
import type { GroupRuntimeSnapshot } from './types.js'

export function publicRuntimeFacts(params: {
  tree: ClientState['ratchetTree']
  anchor: GroupAnchor
  registry: DeviceRegistry
  ownerDID: string
}): PublicRuntimeFacts {
  return publicMembershipFacts(params)
}

export function accountedRuntime(params: {
  observation: AccountedGroupObservation
  groupID: string
  ownerDID: string
  previous: GroupRecoveryTrust | null
}): { snapshot: GroupRuntimeSnapshot; admission: SendAdmission } | null {
  const { observation: value, groupID, ownerDID } = params
  if (
    value.lifetimeStatus !== 'readable' ||
    value.metadataStatus !== 'readable' ||
    value.trustStatus !== 'readable' ||
    value.controlStatus !== 'readable' ||
    value.stateStatus !== 'readable'
  )
    return null
  const { lifetime, activeKey, activeVersion, trust, control, terminal } = value
  if (
    lifetime === null ||
    lifetime.groupID !== groupID ||
    lifetime.restorePending ||
    activeKey === null ||
    activeKey.groupID !== groupID ||
    lifetime.activeIncarnation !== activeKey.incarnation ||
    activeKey.incarnation > lifetime.latestIncarnation ||
    activeVersion === null ||
    !Number.isSafeInteger(activeVersion) ||
    activeVersion < 1 ||
    trust === null ||
    control === null ||
    typeof terminal !== 'boolean'
  )
    return null
  try {
    assertTrustTransition(params.previous, trust)
    const anchor = decodeGroupAnchor(trust.genesisAnchor)
    if (
      anchor === null ||
      trust.groupID !== groupID ||
      trust.installed.incarnation !== activeKey.incarnation ||
      normalizeDID(trust.credential.id) !== normalizeDID(ownerDID) ||
      !trust.spentEpochAuthenticators.some(
        (spent) =>
          spent.length === trust.installed.authenticator.length &&
          spent.every((byte, index) => byte === trust.installed.authenticator[index]),
      ) ||
      value.metadata.some(
        (metadata) =>
          metadata.incarnation === activeKey.incarnation &&
          (metadata.deleted || metadata.groupID !== groupID || metadata.version !== activeVersion),
      )
    )
      return null
    // Projection consumes validated public leaves, never malformed identities or time claims.
    for (const node of trust.signerTree) {
      if (node?.nodeType !== 1) continue
      if (!('identity' in node.leaf.credential)) return null
      const parsed = parseMLSCredentialIdentity(node.leaf.credential.identity)
      if (parsed.controller == null) continue
      const payload = decodeSignedToken(parsed.controller.capability).payload
      if (
        typeof payload.iat !== 'number' ||
        !Number.isFinite(payload.iat) ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp)
      )
        return null
      const parent = Array.isArray(payload.cap) ? payload.cap[0] : payload.cap
      if (parent != null) {
        if (typeof parent !== 'string') return null
        const time = decodeSignedToken(parent).payload.iat
        if (typeof time !== 'number' || !Number.isFinite(time)) return null
      }
    }
    const facts = publicRuntimeFacts({
      tree: trust.signerTree,
      anchor,
      registry: trust.registry,
      ownerDID,
    })
    const epoch = trust.installed.epoch
    const safety = controlSafetyHeld(control)
    return {
      snapshot: {
        ...trust.installed,
        condition: value.condition ?? null,
        authenticator: trust.installed.authenticator.slice(),
        stateVersion: activeVersion,
        members: new Set(facts.members),
        available: facts.ownPresent && !terminal,
      },
      admission:
        safety !== null
          ? { epoch, admissible: false, reason: safety }
          : terminal || !facts.ownPresent
            ? { epoch, admissible: false, reason: 'terminal' }
            : control.strand !== null
              ? { epoch, admissible: false, reason: 'stranded' }
              : facts.lapsed
                ? { epoch, admissible: false, reason: 'lapsed' }
                : { epoch, admissible: true },
    }
  } catch {
    return null
  }
}
