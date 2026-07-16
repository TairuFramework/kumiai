import { describe, expect, test } from 'vitest'

import { detectRemoval } from '../src/roster.js'
import { publishCommit } from './fixtures/commits.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

/**
 * A commit that drops a leaf rotates the app-lane anchor; one that only adds, updates nothing,
 * or does nothing leaves it put. The peer detects it by diffing the roster around the apply — the
 * DIDs it held before against the DIDs it holds after — which catches the decisive Add+Remove
 * case a leaf count would miss, and correctly ignores an external-commit rejoin's lone add.
 *
 * Each case drives a commit through the commit lane (an off-stage admin publishes, the peer wakes
 * and pulls) and reads the anchor epoch: it advances to the post-commit epoch on a removal and
 * stays at genesis otherwise.
 */
describe('a commit that drops a leaf rotates the app-lane anchor', () => {
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

    // The leaf count is unchanged — one out, one in — so only a set diff sees the removal.
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

  test('an add-only commit is NOT detected: the anchor stays put', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x23)
    const bob = makeMLSPeer(hub, 'bob', recoverySecret, { members: ['bob'] })
    await flush()

    await publishCommit({ hub, senderDID: 'alice', recoverySecret, epoch: 1, adds: ['dave'] })
    await flush()

    expect(bob.mls.epoch()).toBe(2) // it advanced
    expect(bob.mls.leaves()).toContain('dave')
    expect(bob.peer.anchorEpoch()).toBe(1) // but nothing was dropped, so the anchor held

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

  test('an external-commit rejoin is NOT detected: it only adds a leaf', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x25)
    // Dave is absent — he is the returning member — so his external commit adds his leaf back.
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
    expect(bob.peer.anchorEpoch()).toBe(1) // an add is not a removal

    await bob.peer.dispose()
  })
})

describe('detectRemoval — set-difference semantics', () => {
  test('a DID present before and absent after is a removal', () => {
    expect(detectRemoval(['a', 'b', 'c'], ['a', 'c'])).toBe(true)
  })

  test('a self-removal — the leaf gone for everyone — is a removal', () => {
    expect(detectRemoval(['a', 'b'], ['a'])).toBe(true)
  })

  test('an Add and a Remove together is a removal, though the count is unchanged', () => {
    expect(detectRemoval(['a', 'b'], ['a', 'c'])).toBe(true)
  })

  test('an add-only is not a removal', () => {
    expect(detectRemoval(['a'], ['a', 'b'])).toBe(false)
  })

  test('an unchanged roster is not a removal', () => {
    expect(detectRemoval(['a', 'b'], ['a', 'b'])).toBe(false)
  })

  test('order and duplicates do not matter', () => {
    expect(detectRemoval(['a', 'b', 'a'], ['b', 'a'])).toBe(false)
    expect(detectRemoval(['b', 'a'], ['a'])).toBe(true)
  })

  test('an empty before roster is never a removal', () => {
    expect(detectRemoval([], ['a', 'b'])).toBe(false)
    expect(detectRemoval([], [])).toBe(false)
  })
})
