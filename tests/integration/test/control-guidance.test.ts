import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

async function guidance(path: string): Promise<string> {
  return (await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8')).replace(/\s+/g, ' ')
}

test('current app lane guidance uses durable operations and transactional control cursors', async () => {
  const doc = await guidance('docs/reference/app-lane.md')
  expect(doc).not.toMatch(/holdLogSends|JournalEntry|CommitJournal|getCommitCursor|putCommitCursor/)
  expect(doc).toMatch(/OperationRequest.*revokes: true/)
  expect(doc).toMatch(/ControlStore.*AdoptionWrite/)
  expect(doc).toMatch(/cursor.*same transaction as.*MLS state/)
  const parent = await guidance('docs/superpowers/specs/2026-10-08-client-messaging-e2e-design.md')
  const layout = parent.split('## Package layout')[1]?.split('### Lift classification')[0]
  expect(layout).toContain('ControlStore')
  expect(layout).not.toContain('CommitJournal')
  const persistence = await guidance(
    'docs/superpowers/specs/2026-10-08-spec-p-transactional-persistence.md',
  )
  const outbox = persistence.split('### D7. Coordinated outbox adapter')[1]?.split('### D8.')[0]
  expect(outbox).not.toContain('putCommitCursor')
  expect(outbox).toMatch(/commit cursor.*ControlStore.*AdoptionWrite/)
})

test('lifecycle guidance retries renewal within the current recovery attempt', async () => {
  const doc = await guidance('docs/reference/mls-lifecycle.md')
  expect(doc).not.toMatch(/refusals.*end as `renewal-required`/)
  expect(doc).toMatch(/Binding, lapse and floor refusals.*same recovery attempt/)
  expect(doc).toMatch(/renewal-required.*fresh.*unavailable/)
  expect(doc).toMatch(/onAccepted\(write\).*required.*AdoptionWrite/)
})

test('RPC guidance explains anchor repair after a co-committed adoption', async () => {
  const doc = await guidance('packages/rpc/README.md')
  expect(doc).not.toContain('commit-applied-before-anchor-saved crash window')
  expect(doc).toMatch(/pending rotation.*before.*adoption/)
  expect(doc).toMatch(/landed mark.*same transaction as.*MLS state/)
  expect(doc).toMatch(/startup.*repair.*target.*exporter/)
  expect(doc).toMatch(/past.*target.*confirmed.*rejoin/)
})

test('the spec describes startup cursor fallback separately from a full readmission reset', async () => {
  const doc = await guidance(
    'docs/superpowers/specs/2026-10-08-spec-p2a-crash-safe-control-design.md',
  )
  expect(doc).not.toContain('P2a has no such rule')
  expect(doc).toMatch(/startup.*clears.*cursor.*epoch.*readEpoch/)
  expect(doc).toMatch(/oldest retained frame/)
  expect(doc).toMatch(/fallback.*does not reset.*operations.*rejoin.*anchor/)
  expect(doc).toMatch(/co-committed.*epoch mismatch/)
})

test.each(['rpc', 'mls-rpc', 'version-band-0-11'])(
  '%s release guidance includes durable rejoin, required adoption writes and renewal retry',
  async (name) => {
    const path = name === 'version-band-0-11' ? name : `crash-safe-control-${name}`
    const doc = await guidance(`.changeset/${path}.md`)
    expect(doc).toMatch(/durable rejoin record/)
    expect(doc).toMatch(/required.*AdoptionWrite/)
    expect(doc).toMatch(/renewal.*same recovery attempt/)
  },
)
