import { describe, expect, test } from 'vitest'

import type { GroupAnchor } from '../src/anchor.js'
import * as foldModule from '../src/fold.js'
import { type FoldDrop, type FoldInput, foldLedger, type LedgerReducer } from '../src/fold.js'

// A tiny self-contained reducer used across the suite: it projects an admin set.
// The genesis anchor's creator is the first admin; an authorized admin may grant
// or revoke another DID. This is the smallest reducer that exercises authority
// against state-so-far, so it stands in for the roster reducer that lands later.
type AdminOp = { op: 'grant' | 'revoke' }
type AdminState = { admins: ReadonlySet<string> }

const adminReducer: LedgerReducer<AdminOp, AdminState> = {
  type: 'admin',
  seed(anchor) {
    return { admins: new Set([anchor.creatorDID]) }
  },
  // Authority is evaluated against the state accumulated so far, never the final
  // state — that is what makes a later revoke leave earlier claims standing.
  verifyAuthority(verified, state) {
    return state.admins.has(verified.issuer)
  },
  apply(verified, state) {
    const admins = new Set(state.admins)
    if (verified.entry.value.op === 'grant') {
      admins.add(verified.entry.subject)
    } else {
      admins.delete(verified.entry.subject)
    }
    return { admins }
  },
}

const GROUP = 'did:group:g'
const ALICE = 'did:alice'
const BOB = 'did:bob'
const CAROL = 'did:carol'
const DAVE = 'did:dave'

const anchor: GroupAnchor = { creatorDID: ALICE, version: 1 }

function op(
  issuer: string,
  target: string,
  action: 'grant' | 'revoke',
  entryID: string,
): FoldInput<AdminOp> {
  return {
    entryID,
    verified: {
      issuer,
      entry: { type: 'admin', groupID: GROUP, subject: target, value: { op: action } },
    },
  }
}

function grant(issuer: string, target: string, entryID: string): FoldInput<AdminOp> {
  return op(issuer, target, 'grant', entryID)
}

function revoke(issuer: string, target: string, entryID: string): FoldInput<AdminOp> {
  return op(issuer, target, 'revoke', entryID)
}

describe('foldLedger', () => {
  test('a caller defines a reducer, folds a list, and reads the projection', () => {
    const entries: Array<FoldInput<AdminOp>> = [grant(ALICE, BOB, '1'), grant(BOB, CAROL, '2')]

    const state = foldLedger(entries, anchor, adminReducer)

    expect([...state.admins].sort()).toEqual([ALICE, BOB, CAROL].sort())
  })

  test('folds in caller order, imposing no order of its own', () => {
    // Grant-then-revoke of the same subject is order-sensitive by construction.
    const forward: Array<FoldInput<AdminOp>> = [grant(ALICE, BOB, '1'), revoke(ALICE, BOB, '2')]
    const reversed: Array<FoldInput<AdminOp>> = [revoke(ALICE, BOB, '2'), grant(ALICE, BOB, '1')]

    const forwardState = foldLedger(forward, anchor, adminReducer)
    const reversedState = foldLedger(reversed, anchor, adminReducer)

    // Forward: Bob is granted then revoked, so only Alice remains.
    expect([...forwardState.admins]).toEqual([ALICE])
    // Reversed: the revoke of a non-admin is a no-op, then Bob is granted, so
    // Bob remains. A fold that sorted internally would collapse these to one
    // result; honouring caller order keeps them distinct.
    expect([...reversedState.admins].sort()).toEqual([ALICE, BOB].sort())
    expect(forwardState.admins).not.toEqual(reversedState.admins)
  })

  test('same entries in the same order, built two ways, fold to equal state', () => {
    const built = [grant(ALICE, BOB, '1'), grant(BOB, CAROL, '2'), revoke(ALICE, BOB, '3')]
    const spread: Array<FoldInput<AdminOp>> = [...built]
    const pushed: Array<FoldInput<AdminOp>> = []
    for (const entry of built) {
      pushed.push(entry)
    }

    const spreadState = foldLedger(spread, anchor, adminReducer)
    const pushedState = foldLedger(pushed, anchor, adminReducer)

    expect([...spreadState.admins].sort()).toEqual([...pushedState.admins].sort())
  })

  test('authority is checked against state-so-far, so rotation is sound', () => {
    // Alice (creator) grants Bob; Bob then grants Carol; Alice later revokes Bob.
    // Bob's grant of Carol was authorized when made and must survive Bob's own
    // later revocation. Evaluating authority against the FINAL state (where Bob
    // is no longer an admin) would retroactively drop it — that is the bug this
    // asserts against.
    const entries: Array<FoldInput<AdminOp>> = [
      grant(ALICE, BOB, '1'),
      grant(BOB, CAROL, '2'),
      revoke(ALICE, BOB, '3'),
    ]

    const state = foldLedger(entries, anchor, adminReducer)

    expect(state.admins.has(CAROL)).toBe(true)
    expect(state.admins.has(BOB)).toBe(false)
    expect(state.admins.has(ALICE)).toBe(true)
  })

  test('an entry of an unrelated type is dropped and leaves state unchanged', () => {
    const unrelated: FoldInput<AdminOp> = {
      entryID: 'x',
      verified: {
        issuer: ALICE,
        entry: { type: 'message', groupID: GROUP, subject: BOB, value: { op: 'grant' } },
      },
    }
    const drops: Array<FoldDrop> = []

    const state = foldLedger([unrelated], anchor, adminReducer, (drop) => drops.push(drop))

    expect([...state.admins]).toEqual([ALICE])
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ entryID: 'x', type: 'message' })
    expect(drops[0]?.reason).toContain('type')
  })

  test('an unauthorized issuer is dropped; the fold runs on and a now-authorized issuer applies', () => {
    // Bob grants Carol before he is an admin (dropped); Alice then grants Bob;
    // Bob's later grant of Dave now applies. One rejected entry never aborts the
    // fold.
    const entries: Array<FoldInput<AdminOp>> = [
      grant(BOB, CAROL, '1'),
      grant(ALICE, BOB, '2'),
      grant(BOB, DAVE, '3'),
    ]
    const drops: Array<FoldDrop> = []

    const state = foldLedger(entries, anchor, adminReducer, (drop) => drops.push(drop))

    expect(state.admins.has(CAROL)).toBe(false)
    expect(state.admins.has(BOB)).toBe(true)
    expect(state.admins.has(DAVE)).toBe(true)
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatchObject({ entryID: '1', type: 'admin' })
    expect(drops[0]?.reason).toContain('authorized')
  })

  test('a frozen input array is neither mutated nor a source of error', () => {
    const entries = Object.freeze([
      grant(ALICE, BOB, '1'),
      grant(BOB, CAROL, '2'),
    ]) as ReadonlyArray<FoldInput<AdminOp>>
    const before = [...entries]

    expect(() =>
      foldLedger(entries as Array<FoldInput<AdminOp>>, anchor, adminReducer),
    ).not.toThrow()
    expect([...entries]).toEqual(before)
    expect(entries[0]?.entryID).toBe('1')
    expect(entries[1]?.entryID).toBe('2')
  })

  test('the module surface is replay-only: foldLedger is the only fold entry point', () => {
    // Types erase at runtime, so the runtime value surface of the module is
    // exactly the set of exported functions — a precise, non-awkward assertion.
    // A per-type incremental applier cannot safely drive a reducer whose
    // authority reads another entry type, so no such export exists by design.
    const valueExports = Object.keys(foldModule).sort()
    expect(valueExports).toEqual(['foldLedger'])
    expect(typeof foldModule.foldLedger).toBe('function')
    expect(foldModule).not.toHaveProperty('applyEntry')
    expect(foldModule).not.toHaveProperty('foldIncremental')
    expect(foldModule).not.toHaveProperty('watermark')
  })
})
