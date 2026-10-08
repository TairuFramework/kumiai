import {
  type KeyPackageBundle,
  keyPackageRef,
  type ProcessWelcomeParams,
  type ProcessWelcomeResult,
  processWelcome,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'

/** A stable source namespace for retained packages and durable join receipts. */
export type BundleSource = {
  readonly sourceID: string
  bundles(): Promise<Array<KeyPackageBundle>>
  /** Call only after the host saves the joined state and its joinRef. */
  consume(ref: string, groupID: string): Promise<void>
  receipt(ref: string): Promise<{ groupID: string } | null>
}

export type OpenWelcomeParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'>

export type JoinedWelcome = ProcessWelcomeResult & {
  /** Sources that failed before another source supplied the matching bundle. */
  sourceErrors?: Array<Error>
}

export type OpenWelcomeResult =
  | { joined: JoinedWelcome; joinRef: { sourceID: string; ref: string } }
  | { alreadyJoined: string }

/** Open and validate without consuming. Receipts take precedence over decryption. */
export async function openWelcome(
  sources: Array<BundleSource>,
  welcome: OpenWelcomeParams,
): Promise<OpenWelcomeResult> {
  const wanted = new Set(welcomeKeyPackageRefs(welcome.welcome))
  const sourceErrors: Array<Error> = []
  const availableSources: Array<BundleSource> = []
  const sourceIDs = new Set<string>()
  for (const source of sources) {
    if (source.sourceID.length === 0 || sourceIDs.has(source.sourceID)) {
      throw new Error('mls-hub: Welcome sources must have distinct non-empty sourceIDs')
    }
    sourceIDs.add(source.sourceID)
  }

  for (const source of sources) {
    try {
      for (const ref of wanted) {
        const receipt = await source.receipt(ref)
        if (receipt != null) return { alreadyJoined: receipt.groupID }
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
        joinRef: { sourceID: source.sourceID, ref },
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
