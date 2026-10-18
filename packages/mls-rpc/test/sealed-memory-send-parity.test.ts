import { encodeClientState, removeMember } from '@kumiai/mls'
import { expect, test } from 'vitest'

import { createRealGroup } from './fixtures/real-group.js'
import { registryHandle } from './fixtures/registry-welcome.js'
import { memoryModel, restoreMemoryControlHandle } from './fixtures/sealed-memory-mls.js'

for (const mode of ['real-mls', 'double'] as const) {
  test(`removed local member cannot send, including after restore / ${mode}`, async () => {
    const group = await createRealGroup(1, `send-removal-${mode}`)
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    const options = { resolveLedgerEntries: group.resolveLedgerEntries }
    const local = await registryHandle({ mode, handle: member.handle, options })
    let commit: Uint8Array
    if (mode === 'real-mls') {
      commit = (
        await removeMember(group.committer.handle, member.handle.state.privatePath.leafIndex)
      ).commitMessage
    } else {
      const author = await registryHandle({ mode, handle: group.committer.handle, options })
      commit = memoryModel(author).buildCommit([], { removes: [member.identity.id] })
    }
    await local.processMessage(commit)
    expect(local.state.groupActiveState.kind).toBe('removedFromGroup')
    const before = encodeClientState(local.state)
    await expect(local.encrypt(new Uint8Array([1]))).rejects.toThrow()
    expect(encodeClientState(local.state)).toEqual(before)
    if (mode === 'double') {
      const restored = await restoreMemoryControlHandle({
        state: local.state,
        credential: local.credential,
        ledgerEntries: local.ledgerTokens,
        options,
      })
      expect(restored.state.groupActiveState.kind).toBe('removedFromGroup')
      await expect(restored.encrypt(new Uint8Array([1]))).rejects.toThrow()
    }
  })

  test(`unapplied self-removal proposal prevents application sends / ${mode}`, async () => {
    const group = await createRealGroup(1, `send-proposal-${mode}`)
    const member = group.members[0]
    if (member === undefined) throw new Error('Missing member')
    await member.handle.proposeSelfRemoval()
    const local = await registryHandle({
      mode,
      handle: member.handle,
      options: { resolveLedgerEntries: group.resolveLedgerEntries },
    })
    expect(Object.keys(local.state.unappliedProposals).length).toBeGreaterThan(0)
    const before = encodeClientState(local.state)
    await expect(local.encrypt(new Uint8Array([1]))).rejects.toThrow(
      'Cannot send application message with unapplied proposals',
    )
    expect(encodeClientState(local.state)).toEqual(before)
  })
}
