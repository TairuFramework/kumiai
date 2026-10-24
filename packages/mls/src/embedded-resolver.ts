import {
  type ControllerLog,
  type ControllerResolver,
  createControllerResolver,
  digestOf,
  type SignedEvent,
} from '@kokuin/controller'
import { type DIDMethodResolver, type MemberQuery, normalizeDID } from '@kokuin/token'

import { asControllerLog, hasChainRevoke } from './controller-log.js'
import { type DeviceRegistry, denySetOf, recordedLogOf } from './registry.js'

const EMPTY: ReadonlySet<string> = new Set()

export function prefixRelation(
  recorded: ControllerLog | undefined,
  prefix: ReadonlyArray<SignedEvent>,
): 'contained' | 'ahead' | 'forked' | 'none' {
  const held = recorded?.chain.at(-1)
  const carried = prefix.at(-1)
  if (recorded == null || held == null || carried == null) return 'none'
  const carriedDigest = digestOf(carried.event)
  if (recorded.chain.some((signed) => digestOf(signed.event) === carriedDigest)) return 'contained'
  const heldDigest = digestOf(held.event)
  return prefix.some((signed) => digestOf(signed.event) === heldDigest) ? 'ahead' : 'forked'
}

/** Root keys come from the leaf prefix; member authority comes from the recorded epoch. */
export function createRegistryControllerResolver(params: {
  controllerID: string
  prefix: ReadonlyArray<SignedEvent>
  registry?: DeviceRegistry
}): ControllerResolver {
  const controller = normalizeDID(params.controllerID)
  const recorded = params.registry == null ? undefined : recordedLogOf(params.registry, controller)
  const denied = params.registry == null ? EMPTY : denySetOf(params.registry)
  const prefix = asControllerLog(params.prefix)
  const resolverFor = (log: ControllerLog) => {
    return createControllerResolver({
      loadLog: async (did) =>
        normalizeDID(did) === controller && !hasChainRevoke(log.chain) ? log : undefined,
    })
  }
  const keys = resolverFor(prefix)
  const members = recorded == null ? keys : resolverFor(recorded)

  function view(keys: DIDMethodResolver, members: DIDMethodResolver): DIDMethodResolver {
    const { method, resolve, resolveHistoric, resolveAgreementKey } = keys
    return {
      method,
      resolve,
      resolveHistoric,
      resolveAgreementKey,
      async resolveDenySet(did: string): Promise<ReadonlySet<string>> {
        if (normalizeDID(did) !== controller) throw new Error(`Unknown DID: ${did}`)
        // Check saturation before substituting the group-folded denials.
        await members.resolveDenySet?.(did)
        return denied
      },
      ...(params.registry == null
        ? {}
        : {
            async resolveMember(did: string, query: MemberQuery) {
              if (normalizeDID(did) !== controller) throw new Error(`Unknown DID: ${did}`)
              if (prefixRelation(recorded, params.prefix) !== 'contained')
                throw new Error('Recorded controller log does not contain the leaf prefix')
              const member = await members.resolveMember?.(did, query)
              if (member == null) throw new Error('Controller member resolution is unavailable')
              return member
            },
          }),
    }
  }

  return {
    ...view(keys, members),
    frozen() {
      const frozenKeys = keys.frozen()
      return view(frozenKeys, members === keys ? frozenKeys : members.frozen())
    },
  }
}
