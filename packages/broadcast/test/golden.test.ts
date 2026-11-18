import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

import { checkGolden } from '../../../scripts/golden.ts'
import { type EncodeEventFrameParams, encodeEventFrame } from '../src/event-frame.js'
import { decodeFrame } from '../src/transport.js'

const file = fileURLToPath(new URL('./golden/event-frame.json', import.meta.url))

test('golden: broadcast v2 event frames', () => {
  const fixtures: Array<{ name: string; input: EncodeEventFrameParams; JSON: string }> = [
    {
      name: 'default empty data',
      input: { prc: 'chat/posted' },
      JSON: '{"payload":{"typ":"event","prc":"chat/posted","data":{}},"v":2}',
    },
    {
      name: 'explicit empty data',
      input: { prc: 'chat/posted', data: {} },
      JSON: '{"payload":{"typ":"event","prc":"chat/posted","data":{}},"v":2}',
    },
    {
      name: 'nested Unicode and escaped data',
      input: {
        prc: 'chat/posted',
        data: {
          text: '組合 🔑\n"hello"',
          kind: 'app',
          nested: { z: [null, true, false, 42, -1.5], a: {} },
        },
      },
      JSON: '{"payload":{"typ":"event","prc":"chat/posted","data":{"text":"組合 🔑\\n\\"hello\\"","kind":"app","nested":{"z":[null,true,false,42,-1.5],"a":{}}}},"v":2}',
    },
  ]
  const cases = fixtures.map(({ name, input, JSON: serialized }) => {
    const bytes = encodeEventFrame(input)
    expect(Buffer.from(bytes).toString('utf8')).toBe(serialized)
    expect(decodeFrame(Buffer.from(serialized, 'utf8'))).toEqual({
      payload: { typ: 'event', prc: input.prc, data: input.data ?? {} },
    })
    return {
      name,
      input,
      expected: {
        JSON: Buffer.from(bytes).toString('utf8'),
        bytes: Buffer.from(bytes).toString('hex'),
      },
    }
  })
  checkGolden(file, cases)
})
