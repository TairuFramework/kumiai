import { describe, expect, test } from 'vitest'

import { FakeHub } from './fixtures/fake-hub.js'
import { buildLedgerCommit, makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

describe('resync() takes the commit mutex', () => {
  test('resync() does not rebuild while a commit holds the lane', async () => {
    const hub = new FakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x11)
    const alice = makeMLSPeer(hub, 'alice', recoverySecret)
    await flush()

    const order: Array<string> = []
    let releaseBuild: (() => void) | undefined
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve
    })

    const build = buildLedgerCommit(alice, [])
    const committing = alice.peer.commit(async () => {
      order.push('build-start')
      await buildGate
      const pending = await build()
      order.push('build-end')
      return pending
    })
    await flush()

    const resyncing = alice.peer.resync().then(() => {
      order.push('resync-done')
    })
    await flush()

    // The commit holds `commitTail`. An unlocked `resync()` would have torn down and rebuilt the
    // epoch here, concurrently with the commit's own rebuild, over shared runtimes/secret/epoch.
    expect(order).toEqual(['build-start'])

    releaseBuild?.()
    await committing
    await resyncing
    expect(order).toEqual(['build-start', 'build-end', 'resync-done'])

    await alice.peer.dispose()
  })
})
