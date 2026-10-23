import { testAppPublicationConformance } from '@kumiai/rpc-conformance'

import { createAppPublicationFixture } from './fixtures/app-publication.js'
import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const context of ['supplied', 'absent'] as const) {
    testAppPublicationConformance({
      label: `${mode} / ${context}`,
      createFixture: () =>
        createAppPublicationFixture(
          mode,
          context === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
        ),
    })
  }
}
