import { describe, expect, test } from 'vitest'

import { hubProtocol } from '../src/protocol.js'

// Every topicID is `toB64U(32 bytes)` from the group's epoch secret (see @kumiai/broadcast's
// deriveTopicID): exactly 43 unpadded base64url characters. The pattern pins that shape so no
// schema-legal value can overflow the fixed-size wake-hint seal record.
const TOPIC_ID_PATTERN = '^[A-Za-z0-9_-]{43}$'

describe('hubProtocol', () => {
  test('defines the pub/sub + bootstrap procedures', () => {
    expect(Object.keys(hubProtocol).sort()).toEqual(
      [
        'hub/v1/keypackage/fetch',
        'hub/v1/keypackage/status',
        'hub/v1/keypackage/upload',
        'hub/v1/publish',
        'hub/v1/receive',
        'hub/v1/subscribe',
        'hub/v1/topic/fetch',
        'hub/v1/unsubscribe',
        'hub/v1/wake/register',
        'hub/v1/wake/unregister',
      ].sort(),
    )
  })

  test('hub/v1/topic/fetch takes no subscriberDID: the caller is the authenticated DID', () => {
    const fetchTopic = hubProtocol['hub/v1/topic/fetch']
    expect(fetchTopic.type).toBe('request')
    expect(fetchTopic.param.required).toEqual(['topicID'])
    // A subscriberDID on the wire would let any member read any topic's log by naming someone
    // else. The server takes it from the verified issuer of the signed message instead.
    expect(fetchTopic.param.properties).not.toHaveProperty('subscriberDID')
    expect(fetchTopic.param.additionalProperties).toBe(false)
    expect(fetchTopic.result.required).toEqual(['messages', 'head', 'oldest'])
  })

  test('hub/v1/publish carries the retention class, the CAS head and the idempotency key', () => {
    const publish = hubProtocol['hub/v1/publish']
    expect(publish.param.properties.retain.enum).toEqual(['log', 'mailbox'])
    // The empty-topic sentinel has to survive the wire as null, distinct from an absent field.
    expect(publish.param.properties.expectedHead.type).toEqual(['string', 'null'])
    expect(publish.param.properties).toHaveProperty('publishID')
    expect(publish.param.required).toEqual(['topicID', 'payload'])
  })

  test('hub/v1/subscribe carries the requested retention', () => {
    expect(hubProtocol['hub/v1/subscribe'].param.properties).toHaveProperty('retention')
  })

  test('removes the legacy group/recipients procedures', () => {
    expect(hubProtocol).not.toHaveProperty('hub/send')
    expect(hubProtocol).not.toHaveProperty('hub/group/send')
    expect(hubProtocol).not.toHaveProperty('hub/group/join')
    expect(hubProtocol).not.toHaveProperty('hub/group/leave')
  })

  test('hub/v1/publish is a request keyed by topicID', () => {
    const publish = hubProtocol['hub/v1/publish']
    expect(publish.type).toBe('request')
    expect(publish.param.required).toEqual(['topicID', 'payload'])
  })

  test('hub/v1/subscribe and hub/v1/unsubscribe are topicID requests', () => {
    expect(hubProtocol['hub/v1/subscribe'].type).toBe('request')
    expect(hubProtocol['hub/v1/subscribe'].param.required).toEqual(['topicID'])
    expect(hubProtocol['hub/v1/unsubscribe'].type).toBe('request')
    expect(hubProtocol['hub/v1/unsubscribe'].param.required).toEqual(['topicID'])
  })

  test('hub/v1/receive carries topicID and not groupID', () => {
    const receive = hubProtocol['hub/v1/receive']
    expect(receive.type).toBe('channel')
    expect(receive.receive.required).toEqual(['sequenceID', 'senderDID', 'topicID', 'payload'])
    expect(receive.receive.properties).not.toHaveProperty('groupID')
    expect(receive.param.properties).not.toHaveProperty('groupIDs')
  })
})

describe('topicID pattern', () => {
  // base64url of 32 zero bytes: 43 'A' characters. A real, legal topicID.
  const legal = 'A'.repeat(43)

  const sites: Array<[string, { pattern?: string }]> = [
    ['publish param', hubProtocol['hub/v1/publish'].param.properties.topicID],
    ['subscribe param', hubProtocol['hub/v1/subscribe'].param.properties.topicID],
    ['unsubscribe param', hubProtocol['hub/v1/unsubscribe'].param.properties.topicID],
    ['topic/fetch param', hubProtocol['hub/v1/topic/fetch'].param.properties.topicID],
    [
      'topic/fetch result frame',
      hubProtocol['hub/v1/topic/fetch'].result.properties.messages.items.properties.topicID,
    ],
    ['receive frame', hubProtocol['hub/v1/receive'].receive.properties.topicID],
  ]

  test.each(sites)('%s carries the topicID pattern', (_name, field) => {
    expect(field.pattern).toBe(TOPIC_ID_PATTERN)
  })

  test('the pattern accepts a real 43-char base64url topicID and rejects overflow shapes', () => {
    // Drive the regex from the schema itself, not the literal above, so this fails if the shipped
    // pattern ever drifts from what a topicID can actually be.
    const shipped = hubProtocol['hub/v1/publish'].param.properties.topicID.pattern
    expect(shipped).toBeDefined()
    const re = new RegExp(shipped as string)
    expect(re.test(legal)).toBe(true)
    // Human-readable and escape-heavy values that are minLength/maxLength-legal but not minted.
    expect(re.test('topic-a')).toBe(false)
    expect(re.test('topic:conformance')).toBe(false)
    expect(re.test('x'.repeat(256))).toBe(false)
    expect(re.test(`${legal}A`)).toBe(false)
    expect(re.test(legal.slice(0, 42))).toBe(false)
  })
})

describe('hub/v1/keypackage/status', () => {
  test('takes no parameters, so there is no DID to authorize', () => {
    const param = hubProtocol['hub/v1/keypackage/status'].param
    expect(param.properties).toEqual({})
    expect(param.additionalProperties).toBe(false)
  })

  test('reports a live count and a nullable last-resort digest', () => {
    const result = hubProtocol['hub/v1/keypackage/status'].result
    expect(result.properties.count).toEqual({ type: 'integer' })
    expect(result.properties.lastResort).toEqual({ type: ['string', 'null'] })
    expect(result.required).toEqual(['count', 'lastResort'])
    expect(result.additionalProperties).toBe(false)
  })
})

describe('hub/v1/keypackage/upload', () => {
  test('accepts an optional batch expiry', () => {
    const param = hubProtocol['hub/v1/keypackage/upload'].param
    expect(param.properties.notAfter).toEqual({ type: 'integer', minimum: 0 })
    expect(param.required).toEqual(['keyPackages'])
    expect(param.additionalProperties).toBe(false)
  })
})

describe('hub/v1/wake/register', () => {
  test('is a sealed request procedure', () => {
    const definition = hubProtocol['hub/v1/wake/register']
    expect(definition.type).toBe('request')
    expect(definition.param.additionalProperties).toBe(false)
    expect(definition.param.required).toEqual(['kind', 'endpoint', 'publicKey', 'authSecret'])
  })

  test('has no did field — the hub uses the authenticated caller', () => {
    expect(hubProtocol['hub/v1/wake/register'].param.properties).not.toHaveProperty('did')
  })
})

describe('hub/v1/wake/unregister', () => {
  test('takes no parameters', () => {
    const definition = hubProtocol['hub/v1/wake/unregister']
    expect(definition.type).toBe('request')
    expect(definition.param.additionalProperties).toBe(false)
    expect(Object.keys(definition.param.properties ?? {})).toEqual([])
  })
})
