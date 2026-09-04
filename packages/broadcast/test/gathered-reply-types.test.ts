import { expectTypeOf, test } from 'vitest'

import type { GatheredReply } from '../src/client.js'

test('GatheredReply carries a typed value and defaults to unknown', () => {
  expectTypeOf<GatheredReply<number>['value']>().toEqualTypeOf<number>()
  expectTypeOf<GatheredReply>().toEqualTypeOf<{ senderDID: string; value: unknown }>()
})
