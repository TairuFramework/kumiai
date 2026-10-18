import { isAppFrameStorageError } from '@kumiai/rpc'
import {
  testGroupCryptoConformance,
  testPendingGroupCryptoConformance,
  testRegistryCryptoConformance,
} from '@kumiai/rpc-conformance'

import {
  createRegistryCryptoFixture,
  createRegistryCryptoGroup,
  createRegistryPendingCryptoFixture,
} from './fixtures/registry-crypto.js'

for (const mode of ['real-mls', 'double'] as const) {
  testRegistryCryptoConformance({
    label: `registry / ${mode}`,
    createFixture: (id) => createRegistryCryptoFixture(mode, id),
  })

  testGroupCryptoConformance({
    label: `registry / ${mode}`,
    createGroup: async (size, id) => {
      const group = await createRegistryCryptoGroup(mode, id, size)
      return {
        members: group.members,
        setEpochHintOffset: group.setEpochHintOffset,
        advance: () => group.advance(),
        removeMember: (index) => group.advance(index),
        dispose: group.close,
      }
    },
  })

  testPendingGroupCryptoConformance({
    label: `registry / ${mode}`,
    isStorageError: isAppFrameStorageError,
    createFixture: (id) => createRegistryPendingCryptoFixture(mode, id),
  })
}
