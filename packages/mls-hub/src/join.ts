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

  for (const source of sources) {
    for (const bundle of await source.bundles()) {
      const ref = await keyPackageRef(bundle.publicPackage, welcomeParams.options)
      if (!wanted.has(ref)) continue
      const result = await processWelcome({ ...welcomeParams, keyPackageBundle: bundle })
      try {
        await source.release(ref)
      } catch (error) {
        return {
          ...result,
          releaseError: error instanceof Error ? error : new Error(String(error)),
        }
      }
      return result
    }
  }

  throw new Error(
    `mls-hub: no retained key package matches this Welcome; it names ${[...wanted].join(', ')}`,
  )
}
