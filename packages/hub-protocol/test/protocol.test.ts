import { describe, expect, test } from 'vitest'

import { hubProtocol } from '../src/protocol.js'

describe('hubProtocol', () => {
  test('defines the pub/sub + bootstrap procedures', () => {
    expect(Object.keys(hubProtocol).sort()).toEqual(
      [
        'hub/v1/keypackage/fetch',
        'hub/v1/keypackage/upload',
        'hub/v1/publish',
        'hub/v1/receive',
        'hub/v1/subscribe',
        'hub/v1/topic/fetch',
        'hub/v1/unsubscribe',
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
