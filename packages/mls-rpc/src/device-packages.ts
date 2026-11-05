import type {
  DevicePackageAdapters,
  DevicePersistence,
  GroupTransaction,
} from './persistence-types.js'

/** Validate descriptors without invoking host operations or claiming their implementation is atomic. */
export function validateDevicePackages<TTx extends GroupTransaction>(
  device: DevicePersistence<TTx>,
  packages: DevicePackageAdapters,
): DevicePackageAdapters {
  function identity(value: { providerID: string; ownerDID: string }): void {
    if (value.providerID !== device.providerID || value.ownerDID !== device.ownerDID)
      throw new TypeError('Package participant provider or owner mismatch')
  }
  function callable(value: unknown): void {
    if (typeof value !== 'function') throw new TypeError('Package operation must be callable')
  }
  function descriptor(value: {
    sourceID: string
    kind: string
    providerID: string
    ownerDID: string
  }): void {
    identity(value)
    if (typeof value.sourceID !== 'string' || value.sourceID.length === 0)
      throw new TypeError('Package source ID must be non-empty')
    if (value.kind !== 'ordinary' && value.kind !== 'last-resort')
      throw new TypeError('Package kind must be ordinary or last-resort')
  }
  if (packages === null || typeof packages !== 'object')
    throw new TypeError('Device package participants are required')
  identity(packages)
  if (!Array.isArray(packages.sources) || !Array.isArray(packages.stores))
    throw new TypeError('Package sources and stores must be arrays')
  callable(packages.rotateAvailability)
  callable(packages.cleanup)
  const sourceIDs = new Set<string>()
  const sources = packages.sources.map((source) => {
    descriptor(source)
    if (sourceIDs.has(source.sourceID)) throw new TypeError('Duplicate package source ID')
    sourceIDs.add(source.sourceID)
    for (const name of ['bundles', 'consume', 'receipt'] as const) callable(source[name])
    return {
      sourceID: source.sourceID,
      kind: source.kind,
      providerID: source.providerID,
      ownerDID: source.ownerDID,
      bundles: source.bundles,
      consume: source.consume,
      receipt: source.receipt,
    }
  })
  const storeIDs = new Set<string>()
  const stores = packages.stores.map((participant) => {
    descriptor(participant)
    if (storeIDs.has(participant.sourceID)) throw new TypeError('Duplicate package store ID')
    storeIDs.add(participant.sourceID)
    for (const name of ['list', 'put', 'delete', 'consume', 'receipt'] as const)
      callable(participant.store[name])
    return {
      sourceID: participant.sourceID,
      kind: participant.kind,
      providerID: participant.providerID,
      ownerDID: participant.ownerDID,
      store: participant.store,
    }
  })
  if (
    sources.length !== stores.length ||
    sources.some(
      (source) =>
        !stores.some((store) => store.sourceID === source.sourceID && store.kind === source.kind),
    )
  )
    throw new TypeError('Package sources and stores require an exact bijection')
  return {
    providerID: packages.providerID,
    ownerDID: packages.ownerDID,
    sources,
    stores,
    rotateAvailability: packages.rotateAvailability,
    cleanup: packages.cleanup,
  }
}
