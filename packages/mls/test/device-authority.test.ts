import { createIdentity } from '@kokuin/token'
import { describe, expect, test } from 'vitest'

import type { GroupAnchor } from '../src/anchor.js'
import type { FoldInput } from '../src/fold.js'
import { createGroup } from '../src/group.js'
import {
  controllerOf,
  DEVICE_ENTRY_TYPE,
  type DeviceValue,
  denySetOf,
  foldControl,
} from '../src/registry.js'

const GROUP = 'device-authority-group'

describe('GroupHandle device registry', () => {
  test('currentDenySet is empty on a fresh group', async () => {
    const creator = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA' }],
      didMethod: 'key',
    })
    const { group } = await createGroup(creator, GROUP)
    expect(group.currentDenySet().size).toBe(0)
    expect(group.registry.devices.size).toBe(0)
  })

  test('a folded register binding is readable through controllerOf/denySetOf', () => {
    // Ruling override (2026-08-17): the brief's original version of this test committed an
    // un-owned kumiai.device register through commitLedgerEntries, authored by a leaf that is
    // not a bound device of the profile it registers. Task 5 adds an authoring device-proof
    // gate inside commitWithEntries (which commitLedgerEntries routes through) that rejects
    // exactly that shape, so this asserts the combined fold directly instead of routing through
    // the real commit path — Task 3 pins the fold/accessor wiring only. Dedicated
    // register-through-a-gated-commit coverage lands in Tasks 8-10 with the bound-device write
    // API.
    const anchor: GroupAnchor = { creatorDID: 'did:key:zCreator', version: 1 }
    const input: FoldInput<DeviceValue> = {
      verified: {
        issuer: 'did:key:zDeviceX',
        entry: {
          type: DEVICE_ENTRY_TYPE,
          groupID: GROUP,
          subject: 'did:key:zDeviceX',
          value: { op: 'register', controller: 'did:kokuin:profileP' },
        },
      },
      entryID: 'e1',
    }
    const { registry } = foldControl([input], anchor, GROUP)
    // normalizeDID only folds did:peer:4 (see @kokuin/token); did:kokuin passes through
    // unchanged, so the controller reads back exactly as registered.
    expect(controllerOf(registry, 'did:key:zDeviceX')).toBe('did:kokuin:profileP')
    expect(denySetOf(registry).size).toBe(0)
  })
})
