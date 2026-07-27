import {
  type KeyPackageBundle,
  keyPackageRef,
  type ProcessWelcomeParams,
  type ProcessWelcomeResult,
  processWelcome,
  welcomeKeyPackageRefs,
} from '@kumiai/mls'

/**
 * Somewhere retained key packages live, and what to do with one once its Welcome has been used.
 *
 * A `KeyPackagePool` releases by deleting: an ordinary package is single-use, and keeping its
 * private half after the join is exactly the forward-secrecy loss the pool exists to close. A
 * `LastResortProvisioner` releases by doing nothing: the same package will be handed to another
 * inviter, and deleting it makes the owner silently unaddable forever.
 */
export type BundleSource = {
  bundles(): Promise<Array<KeyPackageBundle>>
  release(ref: string): Promise<void>
}

export type ProcessWelcomeFromSourcesParams = Omit<ProcessWelcomeParams, 'keyPackageBundle'> & {
  sources: Array<BundleSource>
}

export type ProcessWelcomeFromSourcesResult = ProcessWelcomeResult & {
  /**
   * The join succeeded but the used bundle could not be released — for an ordinary package, its
   * private half is still on disk. Surfaced here rather than thrown, because throwing would take
   * the caller's group away over a storage problem, and swallowed it would be exactly the silent
   * host obligation this wrapper exists to remove.
   */
  releaseError?: Error
  /**
   * The join succeeded, but one or more sources could not be read. Surfaced here rather than
   * swallowed: a source that failed is not the same problem as no bundle matching, and the caller
   * needs told about a store it cannot reach even though the join itself went through.
   */
  sourceErrors?: Array<Error>
}

/**
 * Process a Welcome using whichever retained bundle it names, and release that bundle.
 *
 * Selection is by KeyPackageRef, not by trial decryption: a mismatch is then a named error rather
 * than an undiagnosable crypto failure.
 */
export async function processWelcomeFromSources(
  params: ProcessWelcomeFromSourcesParams,
): Promise<ProcessWelcomeFromSourcesResult> {
  const { sources, ...welcomeParams } = params
  const wanted = new Set(welcomeKeyPackageRefs(welcomeParams.welcome))
  const sourceErrors: Array<Error> = []

  for (const source of sources) {
    // Each source is isolated. `bundles()` throws loudly on a record that does not round-trip, and
    // that rule is right WITHIN a store — one that breaks its own contract is not trusted for its
    // live record either. It does not carry ACROSS stores: letting a corrupt ordinary-pool record
    // abort the scan would deny the last-resort fallback the very outage the slot exists to prevent.
    let available: Array<KeyPackageBundle>
    try {
      available = await source.bundles()
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error : new Error(String(error)))
      continue
    }
    for (const bundle of available) {
      const ref = await keyPackageRef(bundle.publicPackage, welcomeParams.options)
      if (!wanted.has(ref)) continue
      const result = await processWelcome({ ...welcomeParams, keyPackageBundle: bundle })
      const errors = sourceErrors.length > 0 ? { sourceErrors } : {}
      try {
        await source.release(ref)
      } catch (error) {
        return {
          ...result,
          ...errors,
          releaseError: error instanceof Error ? error : new Error(String(error)),
        }
      }
      return { ...result, ...errors }
    }
  }

  // A source that failed is named here too: "no bundle matched" and "a store could not be read" are
  // different problems, and reporting the first while hiding the second sends the caller hunting for
  // a Welcome mismatch that does not exist.
  const failed =
    sourceErrors.length > 0
      ? `; ${sourceErrors.length} source(s) could not be read: ${sourceErrors.map((error) => error.message).join('; ')}`
      : ''
  throw new Error(
    `mls-hub: no retained key package matches this Welcome; it names ${[...wanted].join(', ')}${failed}`,
  )
}
