import { expect, test } from 'vitest'

import { searchOccurrence } from '../src/control/occurrence.js'
import { asLogPosition } from '../src/cursor.js'

test('external occurrence search rejects a non-forward page as a hub fault', async () => {
  await expect(
    searchOccurrence(
      async () => ({
        messages: [
          {
            sequenceID: '000099',
            payload: new Uint8Array([1]),
            senderDID: 'member',
            topicID: 'commits',
            receivedAt: 1,
          },
        ],
        head: '000100',
        oldest: '000099',
        gap: false,
      }),
      asLogPosition('000100'),
      'absent',
    ),
  ).rejects.toThrow('hub returned non-increasing log positions')
})
