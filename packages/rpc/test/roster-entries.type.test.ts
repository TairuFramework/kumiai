import type { GroupMLS, RosterEntry } from '@kumiai/rpc'
import { expectTypeOf, test } from 'vitest'

test('rosterEntries is typed against RosterEntry', () => {
  type Ret = Awaited<ReturnType<GroupMLS['rosterEntries']>>
  expectTypeOf<Ret>().toEqualTypeOf<Array<RosterEntry>>()
  expectTypeOf<RosterEntry['did']>().toEqualTypeOf<string>()
  expectTypeOf<RosterEntry['leafIndex']>().toEqualTypeOf<number>()
  expectTypeOf<RosterEntry['longForm']>().toEqualTypeOf<string>()
})
