import { expect, test } from 'vitest'

import { assertLogPosition } from '../src/cursor.js'

test.each([undefined, 1, {}, '', 'p'.repeat(65)])(
  'malformed fetched position %j is rejected',
  (value) => {
    expect(() => assertLogPosition(value)).toThrow()
  },
)
