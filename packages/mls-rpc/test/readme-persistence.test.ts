import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { encodeClientState, type GroupHandle } from '@kumiai/mls'
import type { AdoptionWrite } from '@kumiai/rpc'
import { expect, test } from 'vitest'

import { type SimpleHandleAccessParams, simpleHandleAccess } from '../src/access.js'
import { createGroupMLS } from '../src/mls.js'
import { buildRealCommit, createRealGroup } from './fixtures/real-group.js'
import { createTransactionalStore } from './fixtures/transactional-access.js'

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const examples = [...readme.matchAll(/persist: (\([^)]*\) => store\.save\([^\n]*\)),/g)].map(
  (match) => match[1],
)
if (examples.length === 0) throw new Error('No documented store persistence callbacks')

test.each(examples)(
  'documented persistence co-commits adoption writes (example %#)',
  async (example) => {
    const group = await createRealGroup(1, 'readme-persistence')
    const member = group.members[0]
    if (member == null) throw new Error('missing member')
    const stored = createTransactionalStore(member.handle)
    const store = {
      save: (current: GroupHandle, write?: AdoptionWrite) => {
        return stored.save(
          stored.snapshot().revision,
          encodeClientState(current.state),
          current.ledgerTokens,
          undefined,
          write,
        )
      },
    }
    const persist = runInNewContext(`(${example})`, {
      store,
    }) as SimpleHandleAccessParams['persist']
    const access = simpleHandleAccess({
      handle: () => member.handle,
      adopt: (next) => {
        member.handle = next
      },
      persist,
      stateVersion: () => stored.snapshot().revision,
    })
    const mls = createGroupMLS({ access, identity: member.identity, entrySlot: member.slot })
    const write = { mutationID: 'documented-adoption', changes: { deleteRejoin: true as const } }
    await mls.processCommit(await buildRealCommit(group), {
      resolveLedgerEntries: group.resolveLedgerEntries,
      adoption: () => write,
    })
    expect(stored.snapshot().mutationID).toBe(write.mutationID)
    expect(stored.snapshot().state).toEqual(encodeClientState(member.handle.state))
  },
)
