import type { OwnIdentity } from '@kokuin/token'
import {
  createKeyPackageBundle,
  createLastResortKeyPackageBundle,
  decodeKeyPackage,
  decodePrivateKeyPackage,
  encodeKeyPackage,
  encodePrivateKeyPackage,
  type KeyPackageBundle,
  keyPackageRef,
} from '@kumiai/mls'

import { createMemoryPackageStores } from '../../src/memory-package-stores.js'
import type {
  DevicePackageAdapters,
  DevicePersistence,
  MemoryTransaction,
  PackageUse,
} from '../../src/persistence-types.js'

export function createDevicePackages(
  device: DevicePersistence<MemoryTransaction>,
  participants: Array<{ sourceID: string; kind: PackageUse['kind'] }> = [],
): DevicePackageAdapters {
  const identity = { providerID: device.providerID, ownerDID: device.ownerDID }
  const stores = participants.map((participant) => {
    return {
      ...identity,
      ...participant,
      store: createMemoryPackageStores({ device, sourceID: participant.sourceID })[
        participant.kind === 'ordinary' ? 'ordinary' : 'lastResort'
      ],
    }
  })
  return {
    ...identity,
    sources: stores.map(({ store, ...descriptor }) => {
      return {
        ...descriptor,
        async bundles() {
          return (await store.list(device.ownerDID)).map((record) => {
            const publicPackage = decodeKeyPackage(record.keyPackage)
            const privatePackage = decodePrivateKeyPackage(record.privatePackage)
            if (publicPackage == null || privatePackage == null) throw new Error('Invalid package')
            return { publicPackage, privatePackage, ownerDID: device.ownerDID }
          })
        },
        consume: store.consume,
        receipt: store.receipt,
      }
    }),
    stores,
    async rotateAvailability() {
      throw new Error('Fixture does not rotate package availability')
    },
    async cleanup() {
      return 'unsupported'
    },
  }
}

export async function provisionDevicePackage(params: {
  device: DevicePersistence<MemoryTransaction>
  identity: OwnIdentity
  sourceID: string
  kind: PackageUse['kind']
  bundle?: KeyPackageBundle
}): Promise<PackageUse> {
  const { device, identity, sourceID, kind } = params
  const bundle =
    params.bundle ??
    (await (kind === 'ordinary' ? createKeyPackageBundle : createLastResortKeyPackageBundle)(
      identity,
    ))
  const record = {
    ref: await keyPackageRef(bundle.publicPackage),
    keyPackage: encodeKeyPackage(bundle.publicPackage),
    privatePackage: encodePrivateKeyPackage(bundle.privatePackage),
    notAfter: Number(bundle.publicPackage.leafNode.lifetime.notAfter),
  }
  const stores = createMemoryPackageStores({ device, sourceID })
  if (kind === 'ordinary') await stores.ordinary.put(device.ownerDID, { ...record, kind })
  else await stores.lastResort.put(device.ownerDID, { ...record, kind, uploadedAt: null })
  return { sourceID, ref: record.ref, kind }
}
