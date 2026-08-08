import { testWakeRegistryConformance } from '@kumiai/hub-conformance'

import { createMemoryWakeRegistry } from '../src/memoryRegistry.js'

testWakeRegistryConformance({ createRegistry: () => createMemoryWakeRegistry() })
