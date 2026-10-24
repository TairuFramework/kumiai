import { readFile } from 'node:fs/promises'
import { deserialize } from 'node:v8'
import {
  authorityPath,
  type ControllerLog,
  canonicalBytes,
  createAdd,
  createInception,
  createRenew,
  createRevoke,
  deriveKeyMaterial,
  didFromInception,
  digestOf,
  encodeKey,
  epochHeads,
  MAX_EPOCH_EVENTS,
} from '@kokuin/controller'
import { createIdentity } from '@kokuin/token'
import { ed25519 } from '@noble/curves/ed25519.js'
import { toB64U } from '@sozai/codec'

import { foldControllerLog } from '../../src/controller-log.js'
import type { DeviceRegistry } from '../../src/registry.js'

export async function buildEpoch({
  members = 3,
  renewEvery = 0,
  until = 0,
  revokes = 0,
}: {
  members?: number
  renewEvery?: number
  until?: number
  revokes?: number
} = {}) {
  const seed = new Uint8Array(32).fill(31)
  const inception = createInception(seed, 0)
  const did = didFromInception(inception.event)
  const log: ControllerLog = { chain: [inception], events: [] }
  const root = { root: { seed, profile: 0 } }
  const headOf = () => {
    const folded = foldControllerLog(did, log)
    if (!folded.ok) throw new Error(folded.reason)
    return folded.head
  }
  const pins = []
  for (let index = 0; index < members; index++) {
    const privateKey = new Uint8Array(32).fill(53 + index)
    const identity = await createIdentity({
      keys: [{ purpose: 'sig', alg: 'EdDSA', privateKey }],
      didMethod: 'peer:4',
    })
    if (identity.longForm == null) throw new Error('Missing member long form')
    const add = createAdd({
      seed,
      profile: 0,
      did,
      head: headOf(),
      parents: epochHeads(did, log),
      member: {
        did: identity.longForm,
        key: encodeKey(identity.publicKey, 'EdDSA'),
        lease: renewEvery || 1000,
      },
    })
    log.events.push(add)
    pins.push({
      identity,
      did: identity.longForm,
      privateKey,
      add: digestOf(add.event),
      event: add,
    })
  }
  for (let index = 0; index < revokes; index++) {
    log.events.push(
      createRevoke({
        did,
        head: headOf(),
        parents: epochHeads(did, log),
        signer: root,
        target: `did:key:denied-${index}`,
      }),
    )
  }
  const genesis = structuredClone(log)
  const deltas: Array<ControllerLog> = []
  if (renewEvery > 0) {
    for (let at = renewEvery; at <= until; at += renewEvery) {
      for (const [index, pin] of pins.entries()) {
        const author = pins[(index + 1) % pins.length]
        const renew = createRenew({
          did,
          head: headOf(),
          parents: epochHeads(did, log),
          signer:
            pins.length < 2 || author == null
              ? root
              : { member: { privateKey: author.privateKey, add: author.add } },
          add: pin.add,
          lease: at + renewEvery,
        })
        log.events.push(renew)
        deltas.push({ chain: [], events: [renew] })
      }
    }
  }
  return { seed, did, inception, log, genesis, deltas, members: pins, head: headOf(), root }
}

type SaturatedFixture = { log: ControllerLog; registry: DeviceRegistry }

let saturated: Promise<SaturatedFixture> | undefined

function saturatedFixture(): Promise<SaturatedFixture> {
  const path = process.env.KUMIAI_MLS_SATURATED_FIXTURE_PATH
  if (path == null || path.length === 0) throw new Error('Missing saturated fixture path')
  saturated ??= readFile(path).then((raw) => deserialize(raw) as SaturatedFixture)
  return saturated
}

export async function saturatedLog(): Promise<ControllerLog> {
  // Each caller can mutate its fixture without rebuilding thousands of signatures.
  return structuredClone((await saturatedFixture()).log)
}

export async function saturatedRegistry(): Promise<DeviceRegistry> {
  return structuredClone((await saturatedFixture()).registry)
}

export async function buildSaturatedLog(): Promise<ControllerLog> {
  const fixture = await buildEpoch({ members: 1 })
  const member = fixture.members[0]
  if (member == null) throw new Error('Missing member')
  const renew = createRenew({
    did: fixture.did,
    head: fixture.head,
    parents: [member.add],
    signer: fixture.root,
    add: member.add,
    lease: 2000,
  })
  const privateKey = deriveKeyMaterial(fixture.seed, authorityPath(0, 0, 0), 'EdDSA')
  for (let index = 0; index < MAX_EPOCH_EVENTS; index++) {
    const event = { ...renew.event, lease: 2000 + index }
    fixture.log.events.push({
      event,
      sigs: [toB64U(ed25519.sign(canonicalBytes(event), privateKey))],
    })
  }
  return fixture.log
}
