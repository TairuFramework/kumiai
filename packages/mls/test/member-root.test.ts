import { stringifyToken } from '@kokuin/token'
import { expect, test } from 'vitest'

import type { ControllerBinding } from '../src/credential.js'
import { memberRootsOf } from '../src/index.js'
import { leafCapabilityFixture } from './fixtures/leaf-capability.js'

test('memberRootsOf reads direct, parent, holder, membership and root roots', async () => {
  const f = await leafCapabilityFixture()
  const memberToken = stringifyToken(
    await f.trusted.signToken({
      ...f.childPayload,
      cap: undefined,
      mbr: { add: 'member-add', g: 2 },
    }),
  )
  const child = stringifyToken(await f.device.signToken({ ...f.childPayload, cap: memberToken }))
  const binding = { id: f.controller.id, prefix: [] }
  const member = { kind: 'member', did: f.trusted.id, add: 'member-add', gen: 2 }
  const root = { kind: 'root', controller: f.controller.id }
  const cases: Array<{ binding: ControllerBinding; expected: unknown }> = [
    {
      binding: { ...binding, capability: memberToken },
      expected: [{ slot: 'capability', root: member }],
    },
    {
      binding: { ...binding, capability: child },
      expected: [{ slot: 'parent', root: member }],
    },
    {
      binding: { ...binding, capability: child, holderGrant: f.parent },
      expected: [
        { slot: 'parent', root: member },
        { slot: 'holder', root },
      ],
    },
    {
      binding: { ...binding, member: { add: 'own-add', g: 0 }, iat: 100 },
      expected: [
        { slot: 'membership', root: { kind: 'member', did: f.device.id, add: 'own-add', gen: 0 } },
      ],
    },
    {
      binding: { ...binding, capability: f.parent, holderGrant: memberToken },
      expected: [
        { slot: 'capability', root },
        { slot: 'holder', root: member },
      ],
    },
  ]
  for (const entry of cases) {
    expect(memberRootsOf(entry.binding, f.device.id)).toEqual(entry.expected)
  }
})
