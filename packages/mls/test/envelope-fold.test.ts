import { normalizeDID } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import { foldEnvelope } from '../src/envelope-fold.js'
import type { FoldInput } from '../src/fold.js'
import { authority as _authority, DEVICE_ENTRY_TYPE, registrySeed } from '../src/registry.js'
import { type GroupPermission, ROLE_ENTRY_TYPE, type RosterState } from '../src/roster.js'

const GROUP_ID = 'group-1'
const OTHER_GROUP = 'group-2'

const CREATOR_DID = 'did:key:zCreator'
const BOB_DID = 'did:key:zBob'
const MEMBER_DID = 'did:key:zMember'

function roster(entries: Array<[string, GroupPermission]>): RosterState {
  return { roles: new Map(entries.map(([did, permission]) => [normalizeDID(did), permission])) }
}

const EMPTY_REGISTRY = registrySeed()

type EntryParams = {
  issuer: string
  type: string
  value?: unknown
  subject?: string
  groupID?: string
  entryID: string
}

function input({
  issuer,
  type,
  value,
  subject = '',
  groupID = GROUP_ID,
  entryID,
}: EntryParams): FoldInput {
  return {
    verified: { issuer: normalizeDID(issuer), entry: { type, groupID, subject, value } },
    entryID,
  }
}

describe('foldEnvelope', () => {
  test('stores and surfaces an admin-issued app entry, roster unchanged', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const appEntry = input({
      issuer: CREATOR_DID,
      type: 'circle.member',
      value: { note: 'welcome' },
      entryID: 'e1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [appEntry], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles).toEqual(base.roles)
      expect(result.surfaced).toEqual([appEntry.verified])
    }
  })

  test('rejects the whole fold when a member issues an app entry', () => {
    const base = roster([
      [CREATOR_DID, 'admin'],
      [MEMBER_DID, 'member'],
    ])
    const memberEntry = input({
      issuer: MEMBER_DID,
      type: 'circle.member',
      value: { note: 'nope' },
      entryID: 'bad',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [memberEntry], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.entryID).toBe('bad')
      expect(result.reason).toContain(normalizeDID(MEMBER_DID))
    }
  })

  test('reads state-so-far: a promoted subject may author a later entry in the same envelope', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const promoteBob = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: BOB_DID,
      value: 'admin',
      entryID: 'promote',
    })
    const bobEntry = input({
      issuer: BOB_DID,
      type: 'circle.member',
      value: { note: 'from bob' },
      entryID: 'bob-app',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [promoteBob, bobEntry], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles.get(normalizeDID(BOB_DID))).toBe('admin')
      expect(result.surfaced).toEqual([bobEntry.verified])
    }
  })

  test('rejects when the same entries are reordered so the issuer is not yet admin', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const promoteBob = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: BOB_DID,
      value: 'admin',
      entryID: 'promote',
    })
    const bobEntry = input({
      issuer: BOB_DID,
      type: 'circle.member',
      value: { note: 'from bob' },
      entryID: 'bob-app',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [bobEntry, promoteBob], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.entryID).toBe('bob-app')
    }
  })

  test('rejects an unknown kumiai.* type', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const mystery = input({
      issuer: CREATOR_DID,
      type: 'kumiai.mystery',
      value: 42,
      entryID: 'm1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [mystery], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unknown kumiai.* type')
      expect(result.entryID).toBe('m1')
    }
  })

  test('surfaces a host entry under the freed `group.` prefix, no longer reserved', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const hostEntry = input({
      issuer: CREATOR_DID,
      type: 'group.settings',
      value: { theme: 'dark' },
      entryID: 'h1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [hostEntry], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles).toEqual(base.roles)
      expect(result.surfaced).toEqual([hostEntry.verified])
    }
  })

  test('passes a non-group entry through unread, never inspecting its value', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const arbitrary = input({
      issuer: CREATOR_DID,
      type: 'app.anything',
      value: { deeply: { nested: ['whatever'] } },
      entryID: 'a1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [arbitrary], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.surfaced).toEqual([arbitrary.verified])
      expect(result.surfaced[0].entry.value).toBe(arbitrary.verified.entry.value)
    }
  })

  test('rejects an entry signed for a different group even when otherwise authorized', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const crossGroup = input({
      issuer: CREATOR_DID,
      type: 'circle.member',
      value: { note: 'replay' },
      groupID: OTHER_GROUP,
      entryID: 'x1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [crossGroup], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('cross-group entry')
      expect(result.entryID).toBe('x1')
    }
  })

  test('rejects a self-demotion that would empty the admin set', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const selfDemote = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: CREATOR_DID,
      value: 'member',
      entryID: 'd1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [selfDemote], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('would empty the admin set')
      expect(result.entryID).toBe('d1')
    }
  })

  test('accepts a demotion when a second admin remains', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const promoteBob = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: BOB_DID,
      value: 'admin',
      entryID: 'promote',
    })
    const selfDemote = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: CREATOR_DID,
      value: 'member',
      entryID: 'demote',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [promoteBob, selfDemote], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles.get(normalizeDID(CREATOR_DID))).toBe('member')
      expect(result.roster.roles.get(normalizeDID(BOB_DID))).toBe('admin')
    }
  })

  test('rejects a kumiai.role whose value is neither admin nor member', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const bogus = input({
      issuer: CREATOR_DID,
      type: ROLE_ENTRY_TYPE,
      subject: BOB_DID,
      value: 'superuser',
      entryID: 'r1',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [bogus], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('invalid role value')
      expect(result.entryID).toBe('r1')
    }
  })

  test('an empty envelope changes no roster and surfaces nothing', () => {
    const base = roster([[CREATOR_DID, 'admin']])

    const result = foldEnvelope(base, EMPTY_REGISTRY, [], GROUP_ID)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.roster.roles).toEqual(base.roles)
      expect(result.surfaced).toEqual([])
    }
  })

  test('a demoted admin cannot relay a ledger entry back in through a colluding admin', () => {
    const base = roster([
      [CREATOR_DID, 'admin'],
      [BOB_DID, 'member'],
    ])
    const colluderEntry = input({
      issuer: CREATOR_DID,
      type: 'circle.member',
      value: { note: 'cover' },
      entryID: 'cover',
    })
    const relayed = input({
      issuer: BOB_DID,
      type: 'circle.member',
      value: { note: 'relayed' },
      entryID: 'relayed',
    })

    const result = foldEnvelope(base, EMPTY_REGISTRY, [colluderEntry, relayed], GROUP_ID)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain(normalizeDID(BOB_DID))
      expect(result.entryID).toBe('relayed')
    }
  })

  test('never throws across any of these inputs', () => {
    const base = roster([
      [CREATOR_DID, 'admin'],
      [MEMBER_DID, 'member'],
    ])
    const cases: Array<Array<FoldInput>> = [
      [],
      [input({ issuer: CREATOR_DID, type: 'circle.member', value: {}, entryID: 'c1' })],
      [input({ issuer: MEMBER_DID, type: 'circle.member', value: {}, entryID: 'c2' })],
      [input({ issuer: CREATOR_DID, type: 'kumiai.mystery', value: 1, entryID: 'c3' })],
      [
        input({
          issuer: CREATOR_DID,
          type: ROLE_ENTRY_TYPE,
          subject: BOB_DID,
          value: 'x',
          entryID: 'c4',
        }),
      ],
      [input({ issuer: CREATOR_DID, type: 'x', value: null, groupID: OTHER_GROUP, entryID: 'c5' })],
    ]
    for (const entries of cases) {
      expect(() => foldEnvelope(base, EMPTY_REGISTRY, entries, GROUP_ID)).not.toThrow()
    }
  })
})

describe('foldEnvelope — kumiai.device branch', () => {
  const profile = 'did:kokuin:profileP'
  const dev = 'did:key:zDev'

  test('a device entry bypasses the admin invariant and folds into the registry', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    // The issuer is a plain device DID, NOT an admin. A role/app entry from it would reject;
    // a device entry is authorized by the pipeline, so the fold applies it structurally.
    const register = input({
      issuer: dev,
      type: DEVICE_ENTRY_TYPE,
      subject: dev,
      value: { op: 'register', controller: profile },
      entryID: 'd1',
    })
    const result = foldEnvelope(base, EMPTY_REGISTRY, [register], GROUP_ID)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(_authority(result.registry, dev)).toBe(normalizeDID(profile))
      expect(result.surfaced).toEqual([]) // kumiai.* is consumed, never surfaced
    }
  })

  test('a malformed device value rejects the whole fold', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const bad = input({
      issuer: dev,
      type: DEVICE_ENTRY_TYPE,
      subject: dev,
      value: { op: 'nope' },
      entryID: 'd-bad',
    })
    const result = foldEnvelope(base, EMPTY_REGISTRY, [bad], GROUP_ID)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.entryID).toBe('d-bad')
  })

  test('admin-as-controller: a device of an admin profile authors a role entry in the same envelope', () => {
    const base = roster([[normalizeDID(profile), 'admin']])
    const register = input({
      issuer: dev,
      type: DEVICE_ENTRY_TYPE,
      subject: dev,
      value: { op: 'register', controller: profile },
      entryID: 'd1',
    })
    const grant = input({
      issuer: dev,
      type: ROLE_ENTRY_TYPE,
      subject: 'did:key:zNew',
      value: 'member',
      entryID: 'r1',
    })
    const result = foldEnvelope(base, EMPTY_REGISTRY, [register, grant], GROUP_ID)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.roster.roles.get(normalizeDID('did:key:zNew'))).toBe('member')
  })

  test('an unknown kumiai.* type still fails closed', () => {
    const base = roster([[CREATOR_DID, 'admin']])
    const mystery = input({ issuer: CREATOR_DID, type: 'kumiai.mystery', value: {}, entryID: 'm1' })
    const result = foldEnvelope(base, EMPTY_REGISTRY, [mystery], GROUP_ID)
    expect(result.ok).toBe(false)
  })
})
