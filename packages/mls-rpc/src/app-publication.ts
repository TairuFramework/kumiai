import type { AppPublicationPort } from '@kumiai/rpc'

import type { RegistryHandleAccess } from './registry/types.js'

export function createRegistryAppPublication(access: RegistryHandleAccess): AppPublicationPort {
  return {
    assertRoot: () => access.assertPublicationEntry(),
    prepare: (entry, floor) => access.preparePublication(entry, floor),
    snapshot: (protocol) => access.publicationSnapshot(protocol),
  }
}
