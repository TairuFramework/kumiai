import type { ProtocolDefinition } from '@enkaku/protocol'
import { normalizeDID } from '@kokuin/token'
import { encodeEventFrame } from '@kumiai/broadcast'
import { fromUTF } from '@sozai/codec'
import { describe, expect, test } from 'vitest'

import { createGroupPeer } from '../src/peer.js'
import { detectRosterChange } from '../src/roster.js'
import { APP_TOPIC_LABEL, inboxTopic, protocolTopic } from '../src/topic.js'
import { DurableFakeHub } from './fixtures/durable-fake-hub.js'
import { createFakeCrypto, fakeEpochSecret } from './fixtures/fake-crypto.js'
import { FakeHub } from './fixtures/fake-hub.js'
import { makeMLSPeer } from './fixtures/peer.js'

const flush = () => new Promise((r) => setTimeout(r, 30))

// A did:peer:4 pair `normalizeDID` folds onto the same short form — see @kokuin/token's `did.ts`.
// The short form is a plain prefix of the long one, up to the first `:` past `did:peer:4`.
const SHORT_B = 'did:peer:4zBobShort'
const LONG_B = 'did:peer:4zBobShort:eyLongFormSuffix'

const proto = {
  ping: { type: 'request', param: { type: 'object' }, result: { type: 'object' } },
} as const satisfies ProtocolDefinition

type Protocols = { proto: typeof proto }

function makePeer(hub: FakeHub, localDID: string, handlers: Record<string, unknown> = {}) {
  const crypto = createFakeCrypto({ epoch: 1, localDID })
  return createGroupPeer<Protocols>({
    hub,
    crypto,
    localDID,
    protocols: { proto },
    handlers: { proto: handlers } as never,
  })
}

describe('DID normalization at rpc ingress', () => {
  test('directed call to a long-form DID matches short-form MLS replies', async () => {
    const hub = new FakeHub()
    // B's own crypto stamps the SHORT form as sender — modelling MLS returning the credential's
    // canonical short form regardless of the alias A addressed it by.
    const a = makePeer(hub, 'a')
    const b = makePeer(hub, SHORT_B, { ping: () => ({ pong: true }) })
    await flush()

    // A addresses B by its LONG form. Without ingress normalization, the directed client's
    // filter (`message.senderDID !== memberDID`) would compare the long alias against B's
    // short-form replies and never match — the request would hang and reject on timeout.
    const client = await a.protocol('proto').to(LONG_B)
    const result = await client.request('ping', { param: {} })

    expect(result).toEqual({ pong: true })

    await a.dispose()
    await b.dispose()
  })

  test('roster change is not detected on an equivalent DID-form flip', () => {
    // Mirrors the fix at the `rosterEntries()` ingress (`peer.ts`): normalize before diffing, not
    // inside `detectRosterChange` itself (which stays a pure set-equality check).
    const before = [SHORT_B, 'carol'].map(normalizeDID)
    const after = [LONG_B, 'carol'].map(normalizeDID)
    expect(detectRosterChange(before, after)).toBe(false)

    // Unnormalized, the same pair of reads looks like a roster change — proving the ingress
    // normalization is load-bearing and not a no-op on these inputs.
    expect(detectRosterChange([SHORT_B, 'carol'], [LONG_B, 'carol'])).toBe(true)
  })

  test('self-echo suppression holds across DID forms in the app-lane drain', async () => {
    const hub = new DurableFakeHub()
    const recoverySecret = new Uint8Array(32).fill(0x77)
    const anchorSecret = fakeEpochSecret(1, APP_TOPIC_LABEL)
    const chatTopicID = protocolTopic(anchorSecret, 1, 'chat')

    // Published BEFORE bob's peer exists, so both frames are read back on his first history
    // pull (app-lane.ts's `drain`), never through the live push — isolating the drain's own
    // `opened.senderDID === localDID` check from any live-path filtering.
    const echoCrypto = createFakeCrypto({ epoch: 1, localDID: LONG_B })
    const echoSealed = await echoCrypto.wrap(encodeEventFrame('chat/posted', { text: 'echo' }), {
      aad: fromUTF(chatTopicID),
    })
    await hub.publish({
      senderDID: LONG_B,
      topicID: chatTopicID,
      payload: echoSealed,
      retain: 'log',
    })

    const carolCrypto = createFakeCrypto({ epoch: 1, localDID: 'carol' })
    const carolSealed = await carolCrypto.wrap(
      encodeEventFrame('chat/posted', { text: 'from carol' }),
      {
        aad: fromUTF(chatTopicID),
      },
    )
    await hub.publish({
      senderDID: 'carol',
      topicID: chatTopicID,
      payload: carolSealed,
      retain: 'log',
    })

    const seen: Array<unknown> = []
    const bob = makeMLSPeer(hub, SHORT_B, recoverySecret, {
      epoch: 1,
      handlers: { 'chat/posted': (ctx: { data: unknown }) => void seen.push(ctx.data) },
    })
    await flush()

    // The long-form echo of bob's own SHORT identity is suppressed; carol's frame, a genuinely
    // different sender, still delivers — proving the suppression is DID-specific, not blanket.
    expect(seen).toEqual([{ text: 'from carol' }])

    await bob.peer.dispose()
  })

  test('short-form inbox topic is unchanged (golden pin)', () => {
    // Computed with `inboxTopic` BEFORE any ingress normalization was added (see task-5-report.md
    // for how). A short-form DID is already canonical, so normalizing it at ingress must move
    // nothing — this pins that no rotation occurred.
    const secret = new Uint8Array(32).fill(7)
    expect(inboxTopic(secret, 1, 'did:peer:4zQmShort')).toBe(
      'p1PLMa1iPmh-AkN44pvTl7gdIoidbm7MyxrUtM-QiDQ',
    )
  })
})
