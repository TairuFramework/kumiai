import { describe, expect, test } from 'vitest'

import { detectRosterChange } from '../src/roster.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/**
 * A commit that CHANGES the roster rotates the app-lane anchor; one that touches no leaf leaves
 * it put however far the epoch runs on. The peer detects it by diffing the roster around the
 * apply — the DIDs it held before against the DIDs it holds after — which catches the decisive
 * Add+Remove case a leaf count would miss.
 *
 * An Add rotates it for the same reason a Remove does, from the other side: a Remove must move the
 * anchor because the evicted member keeps every topic ID it derived, and an Add must move it
 * because MLS ratchets forward and a member added at epoch E can never export the secret of an
 * earlier one. The anchor has to be both after every removal and derivable by every current
 * member, and only the last roster change is both.
 *
 * Each case drives a commit through the commit lane (an off-stage admin publishes, the peer wakes
 * and pulls) and reads the anchor epoch: it advances to the post-commit epoch on a roster change
 * and stays at genesis otherwise.
 */
describe('a commit that changes the roster rotates the app-lane anchor', () => {
  test('a remove-only commit is detected: the anchor advances', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x21)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob', 'carol'] })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(1)

    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, removes: ['carol'] })
    await flush()

    expect(bob.mls.epoch()).toBe(2) // the commit advanced the epoch
    expect(bob.mls.leaves()).not.toContain('carol') // the leaf is gone
    expect(bob.peer.anchorEpoch()).toBe(2) // and the anchor rotated with it

    await bob.peer.dispose()
  })

  test('an Add and a Remove in one commit is detected — the case a count check misses', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x22)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob', 'carol'] })
    await flush()
    expect(bob.peer.anchorEpoch()).toBe(1)

    // The leaf count is unchanged — one out, one in — so only a set comparison sees the change.
    await publishCommit({
      hub,
      senderDID: 'alice',
      recoverySecret,
      epoch: 1,
      adds: ['dave'],
      removes: ['carol'],
    })
    await flush()

    expect(bob.mls.leaves()).toEqual(['bob', 'dave']) // carol out, dave in — count unchanged
    expect(bob.peer.anchorEpoch()).toBe(2)

    await bob.peer.dispose()
  })

  test("an add-only commit is detected: the anchor advances to the joiner's add epoch", async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x23)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob'] })
    await flush()

    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, adds: ['dave'] })
    await flush()

    expect(bob.mls.epoch()).toBe(2) // it advanced
    expect(bob.mls.leaves()).toContain('dave')
    // Dave joined at epoch 2 and can export no secret older than it, so an anchor left at 1 is one
    // he could never derive. Bob rotates to the epoch the add landed at — where Dave starts.
    expect(bob.peer.anchorEpoch()).toBe(2)

    await bob.peer.dispose()
  })

  test('an update / no-op commit is NOT detected, even as it advances the epoch', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x24)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob', 'carol'] })
    await flush()

    // No roster op — the roster is identical before and after — yet the epoch still advances.
    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1 })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.leaves()).toEqual(['bob', 'carol'])
    expect(bob.peer.anchorEpoch()).toBe(1)

    await bob.peer.dispose()
  })

  test('an external-commit rejoin by a member the roster lost is detected: it brings a DID back', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x25)
    // Dave is absent from Bob's tree — he is the returning member — so his external commit puts a
    // DID back into the roster Bob holds, and Bob sees a change.
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob'] })
    await flush()

    await publishCommit({
      hub,
      senderDID: 'alice',
      committerDID: 'dave',
      recoverySecret,
      epoch: 1,
      external: true,
    })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.leaves()).toContain('dave') // the rejoin added dave's leaf
    // Dave's rejoined handle starts at the epoch the rejoin reached, so the anchor must come to
    // meet him, exactly as it does for a member added by an ordinary Add.
    expect(bob.peer.anchorEpoch()).toBe(2)

    await bob.peer.dispose()
  })

  test('an external-commit rejoin by a member still IN the roster is invisible to a DID diff', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x26)
    // Dave never lost his leaf here — he is stranded on an old epoch, not evicted — so his rejoin
    // REPLACES a leaf the roster already held for him, and the DID set does not move.
    //
    // The predicate's honest edge, asserted rather than left to be discovered: the diff compares
    // DIDs, and a rejoin that replaces a leaf changes no DID. It stays consistent — every member
    // runs this same diff over this same commit, none rotates, and they still agree on the topic —
    // but it leaves the rejoined handle deriving an anchor epoch it no longer holds the secret
    // for, which the epoch-independent secret in this double hides.
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob', 'dave'] })
    await flush()

    await publishCommit({
      hub,
      senderDID: 'alice',
      committerDID: 'dave',
      recoverySecret,
      epoch: 1,
      external: true,
    })
    await flush()

    expect(bob.mls.epoch()).toBe(2)
    expect(bob.mls.leaves()).toEqual(['bob', 'dave']) // one leaf for dave, and the same DIDs
    expect(bob.peer.anchorEpoch()).toBe(1)

    await bob.peer.dispose()
  })
})

describe('detectRosterChange — set-inequality semantics', () => {
  test('a DID present before and absent after is a change', () => {
    expect(detectRosterChange(['a', 'b', 'c'], ['a', 'c'])).toBe(true)
  })

  test('a self-removal — the leaf gone for everyone — is a change', () => {
    expect(detectRosterChange(['a', 'b'], ['a'])).toBe(true)
  })

  test('an Add and a Remove together is a change, though the count is unchanged', () => {
    expect(detectRosterChange(['a', 'b'], ['a', 'c'])).toBe(true)
  })

  test('an add-only is a change: the set-difference predicate missed exactly this', () => {
    expect(detectRosterChange(['a'], ['a', 'b'])).toBe(true)
  })

  test('an unchanged roster is not a change', () => {
    expect(detectRosterChange(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  test('order and duplicates do not matter', () => {
    expect(detectRosterChange(['a', 'b', 'a'], ['b', 'a'])).toBe(false)
    expect(detectRosterChange(['b', 'a'], ['a'])).toBe(true)
    expect(detectRosterChange(['a'], ['a', 'a'])).toBe(false)
  })

  test('an empty before roster gaining a DID is a change', () => {
    expect(detectRosterChange([], ['a', 'b'])).toBe(true)
    expect(detectRosterChange([], [])).toBe(false)
  })
})
