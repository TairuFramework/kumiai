import {
  type KeyPackageBundle,
  keyPackageRef,
  type ProcessWelcomeParams,
  type ProcessWelcomeResult,
  processWelcome,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'

export type PackageUse = { sourceID: string; ref: string; kind: 'ordinary' | 'last-resort' }

/** A stable source namespace for retained packages and durable consumption receipts. */
export type BundleSource = {
  sourceID: string
  kind: PackageUse['kind']
  bundles(): Promise<Array<KeyPackageBundle>>
  /** Call only after the host saves the joined state and its packageUse. */
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
}

export type OpenWelcomeParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'>

export type JoinedWelcome = ProcessWelcomeResult & {
  /** Sources that failed before another source supplied the matching bundle. */
  sourceErrors?: Array<Error>
}

export type OpenWelcomeResult =
  | { joined: JoinedWelcome; packageUse: PackageUse }
  | { refused: 'package-consumed'; packageUse: PackageUse }

/** Open without consuming. Ordinary receipts refuse use before decryption, never grant admission. */
export async function openWelcome(
  sources: Array<BundleSource>,
  welcome: OpenWelcomeParams,
): Promise<OpenWelcomeResult> {
  const sourceErrors: Array<Error> = []
  const availableSources: Array<BundleSource> = []
  const sourceIDs = new Set<string>()
  for (const source of sources) {
    if (
      typeof source.sourceID !== 'string' ||
      source.sourceID.length === 0 ||
      sourceIDs.has(source.sourceID)
    ) {
      throw new Error('mls-hub: Welcome sources must have distinct non-empty sourceIDs')
    }
    if (source.kind !== 'ordinary' && source.kind !== 'last-resort') {
      throw new Error('mls-hub: Welcome source kind must be ordinary or last-resort')
    }
    sourceIDs.add(source.sourceID)
  }

  const wanted = new Set(welcomeKeyPackageRefs(welcome.welcome))
  for (const source of sources) {
    try {
      if (source.kind === 'ordinary') {
        for (const ref of wanted) {
          const receipt = await source.receipt(ref)
          if (receipt != null) {
            return {
              refused: 'package-consumed',
              packageUse: { sourceID: source.sourceID, ref, kind: source.kind },
            }
          }
        }
      }
      availableSources.push(source)
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error : new Error(String(error)))
    }
  }

  for (const source of availableSources) {
    let available: Array<KeyPackageBundle>
    try {
      available = await source.bundles()
    } catch (error) {
      // A corrupt pool must not prevent opening via an independent fallback source.
      sourceErrors.push(error instanceof Error ? error : new Error(String(error)))
      continue
    }
    const refs = await Promise.all(
      available.map((bundle) => keyPackageRef(bundle.publicPackage, welcome.options)),
    )
    for (const [index, bundle] of available.entries()) {
      const ref = refs[index] as string
      if (!wanted.has(ref)) continue
      const joined = await processWelcome({ ...welcome, keyPackageBundle: bundle })
      return {
        joined: { ...joined, ...(sourceErrors.length > 0 ? { sourceErrors } : {}) },
        packageUse: { sourceID: source.sourceID, ref, kind: source.kind },
      }
    }
  }

  const failed =
    sourceErrors.length > 0
      ? `; ${sourceErrors.length} source(s) could not be read: ${sourceErrors.map((error) => error.message).join('; ')}`
      : ''
  throw new Error(
    `mls-hub: no retained key package matches this Welcome; it names ${[...wanted].join(', ')}${failed}`,
  )
}
