import { decodeFrame, encodeEnvelope, encodeFrame, type MailboxHub } from '@kumiai/hub-tunnel'
import { FrameEpochError } from '@kumiai/rpc'
import { toB64 } from '@sozai/codec'
import { describe, expect, onTestFinished, test, vi } from 'vitest'

import { MLSEncryptor, type MLSEncryptorParams } from '../src/mls-encryptor.js'
import { sourceResultBinding } from '../src/registry/source-crypto-commands.js'
import { registrySourceExecutor } from '../src/registry/source-executor.js'
import type { GroupRuntimeSnapshot, ReceiveResult } from '../src/registry/types.js'
import { createRegistryLeaseFixture } from './fixtures/registry-lease.js'

function message(typ = 'request', rid = 'rid', sessionID = 'session', seq = 0) {
  return encodeFrame({
    v: 1,
    sessionID,
    seq,
    kind: 'message',
    body: { header: {}, payload: { typ, rid, prc: 'records/sync' } },
  })
}

function sessionEnd(sessionID = 'session') {
  return encodeFrame({ v: 1, sessionID, seq: 1, kind: 'session-end' })
}

for (const mode of ['real-mls', 'double'] as const) {
  describe(`MLSEncryptor (${mode})`, () => {
    async function setup(role: 'dialer' | 'listener' = 'listener') {
      const fixture = await createRegistryLeaseFixture(mode, 'welcome')
      onTestFinished(() => fixture.close())
      const access = fixture.access()
      const peer = await fixture.peerAccess()
      const peerDID = fixture.group?.sender.identity.id
      if (peerDID === undefined) throw new Error('Missing peer')
      const params = { access, peerDID, role }
      const local = new MLSEncryptor(params)
      const remote = new MLSEncryptor({
        access: peer,
        peerDID: fixture.fixture().identity.id,
        role: 'listener',
      })
      return { fixture, access, peer, params, local, remote }
    }

    test('both registry-backed members encrypt and decrypt with empty ephemeral AAD', async () => {
      const { local, remote, access, fixture } = await setup()
      const commands = vi.spyOn(
        registrySourceExecutor(fixture.fixture().registry).executor,
        'execute',
      )
      const seal = vi.spyOn(access, 'seal')
      const plaintext = message()
      const encrypted = await local.encrypt(plaintext)
      expect(sourceResultBinding(encrypted)?.key).toEqual(fixture.key)
      expect(await remote.decrypt(encrypted)).toEqual(plaintext)
      expect(await local.decrypt(await remote.encrypt(plaintext))).toEqual(plaintext)
      expect(commands.mock.calls.map(([request]) => request.command)).toContain('app.seal')
      expect(commands.mock.calls.map(([request]) => request.command)).toContain('app.receive')
      expect(seal).toHaveBeenCalledWith(plaintext, {
        aad: new Uint8Array(),
        intent: 'ephemeral',
      })
    })

    test('round-trip carries 1KB of random frame data', async () => {
      const { local, remote } = await setup()
      const plaintext = encodeFrame({
        v: 1,
        sessionID: 'random',
        seq: 0,
        kind: 'message',
        body: {
          header: {},
          payload: { typ: 'request', rid: 'random' },
          data: toB64(crypto.getRandomValues(new Uint8Array(1024))),
        },
      })
      expect(await remote.decrypt(await local.encrypt(plaintext))).toEqual(plaintext)
    })

    test('nameable sender must match the scoped hub publisher', async () => {
      const { params, remote } = await setup()
      const local = new MLSEncryptor({ ...params, peerDID: 'did:test:someone-else' })
      await expect(local.decrypt(await remote.encrypt(message()))).rejects.toThrow(
        'MLS sender does not match hub publisher',
      )
    })

    test('rejects a different current member as the scoped publisher', async () => {
      const { fixture, access, params, remote } = await setup()
      const peerDID = fixture.fixture().identity.id
      expect(access.runtime.snapshot()?.members.has(peerDID)).toBe(true)
      const local = new MLSEncryptor({ ...params, peerDID })
      await expect(local.decrypt(await remote.encrypt(message()))).rejects.toThrow(
        'MLS sender does not match hub publisher',
      )
    })

    test('removed peer outstanding reply rejects without an active watcher', async () => {
      const { fixture, access, local, remote } = await setup('dialer')
      await local.encrypt(message())
      const reply = await remote.encrypt(message('receive'))
      await fixture.removePeer()
      const receive = vi.spyOn(access, 'receive')
      await expect(local.decrypt(reply)).rejects.toThrow('no longer a group member')
      expect(await receive.mock.results[0]?.value).toMatchObject([
        { kind: 'opened', handleEpoch: access.runtime.snapshot()?.epoch },
      ])
    })

    test('lagging membership snapshot rejects an old reply after peer removal', async () => {
      const { fixture, access, local, remote } = await setup('dialer')
      await local.encrypt(message())
      const reply = await remote.encrypt(message('receive'))
      const initial = access.runtime.snapshot()
      if (initial === null) throw new Error('Missing snapshot')
      await fixture.removePeer()
      const current = access.runtime.snapshot()
      expect(current?.epoch).toBe(initial.epoch + 1)
      const receive = vi.spyOn(access, 'receive')
      vi.spyOn(access.runtime, 'snapshot').mockReturnValue(initial)
      await expect(local.decrypt(reply)).rejects.toThrow()
      expect(await receive.mock.results[0]?.value).toMatchObject([
        { kind: 'opened', frameEpoch: initial.epoch, handleEpoch: current?.epoch },
      ])
    })

    test('membership snapshot from another incarnation rejects an outstanding reply', async () => {
      const { fixture, access, local, remote } = await setup('dialer')
      await local.encrypt(message())
      const reply = await remote.encrypt(message('receive'))
      await fixture.advanceEpoch()
      const current = access.runtime.snapshot()
      if (current === null) throw new Error('Missing snapshot')
      vi.spyOn(access.runtime, 'snapshot').mockReturnValue({
        ...current,
        incarnation: current.incarnation + 1,
      })
      await expect(local.decrypt(reply)).rejects.toThrow()
    })

    test('watch unsubscribes from runtime when it closes', async () => {
      const { fixture, access, local } = await setup()
      const subscribe = access.runtime.onEpochChanged
      const unsubscribe = vi.fn()
      vi.spyOn(access.runtime, 'onEpochChanged').mockImplementation((listener) => {
        unsubscribe.mockImplementation(subscribe(listener))
        return unsubscribe
      })
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.setUnavailable()
      expect(dispose).toHaveBeenCalledOnce()
      expect(unsubscribe).toHaveBeenCalledOnce()
      unwatch()
      expect(unsubscribe).toHaveBeenCalledOnce()
    })

    test('initial watch close leaves no runtime subscription', async () => {
      const { fixture, access, local } = await setup()
      await fixture.setUnavailable()
      const subscribe = vi.spyOn(access.runtime, 'onEpochChanged')
      const dispose = vi.fn(async () => {})
      local.watchPeerRemoval(dispose)()
      expect(dispose).toHaveBeenCalledOnce()
      expect(subscribe).not.toHaveBeenCalled()
    })

    test('watch epoch regression closes once', async () => {
      const { fixture, access, local } = await setup()
      const subscribe = access.runtime.onEpochChanged
      let notify: ((value: GroupRuntimeSnapshot | null) => void) | undefined
      vi.spyOn(access.runtime, 'onEpochChanged').mockImplementation((listener) => {
        notify = listener
        return subscribe(listener)
      })
      const initial = access.runtime.snapshot()
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.advanceEpoch()
      expect(dispose).not.toHaveBeenCalled()
      notify?.(initial)
      notify?.(initial)
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    })

    test('clear during an in-flight seal cannot restore outstanding requests', async () => {
      const { fixture, access, local, remote } = await setup('dialer')
      const seal = access.seal
      const entered = Promise.withResolvers<void>()
      const blocked = Promise.withResolvers<void>()
      vi.spyOn(access, 'seal').mockImplementationOnce(async (plaintext, options) => {
        const sealed = await seal(plaintext, options)
        entered.resolve()
        await blocked.promise
        return sealed
      })
      const sending = local.encrypt(message())
      await entered.promise
      local.clear()
      blocked.resolve()
      await sending
      const reply = await remote.encrypt(message('receive'))
      await fixture.advanceEpoch()
      await expect(local.decrypt(reply)).rejects.toThrow('not an outstanding reply')
    })

    for (const [reason, frameEpoch] of [
      ['past-epoch', 0],
      ['future-epoch', 2],
    ] as const) {
      test(`${reason} receive refusal preserves the port FrameEpochError class`, async () => {
        const { access, local } = await setup()
        vi.spyOn(access, 'receive').mockResolvedValueOnce([
          { kind: 'refused', reason, frameEpoch, handleEpoch: 1 },
        ])
        const result = local.decrypt(message())
        await expect(result).rejects.toBeInstanceOf(FrameEpochError)
        await expect(result).rejects.toMatchObject({ frameEpoch, handleEpoch: 1 })
      })
    }

    test('decrypt deduplicates in flight, batches in a microtask and opens no transaction', async () => {
      const { fixture, access, local, remote } = await setup()
      const ciphertexts = []
      for (let index = 0; index < 3; index++)
        ciphertexts.push(await remote.encrypt(message('request', `${index}`)))
      await fixture.drainMaintenance()
      const transactions = fixture.transactions()
      const receive = vi.spyOn(access, 'receive')
      const first = local.decrypt(ciphertexts[0] as Uint8Array)
      expect(local.decrypt(ciphertexts[0] as Uint8Array)).toBe(first)
      const opened = Promise.all([
        first,
        local.decrypt(ciphertexts[1] as Uint8Array),
        local.decrypt(ciphertexts[2] as Uint8Array),
      ])
      expect(receive).not.toHaveBeenCalled()
      expect(await opened).toEqual([
        message('request', '0'),
        message('request', '1'),
        message('request', '2'),
      ])
      expect(receive).toHaveBeenCalledExactlyOnceWith(
        ciphertexts.map((ciphertext) => ({ ciphertext, expectedAAD: new Uint8Array() })),
      )
      expect(fixture.transactions()).toBe(transactions)
      await expect(local.decrypt(ciphertexts[0] as Uint8Array)).rejects.toThrow()
    })

    test('opened count includes malformed plaintext and item failures do not discard siblings', async () => {
      const { fixture, access, peer, local, remote } = await setup()
      const malformed = (
        await peer.seal(new Uint8Array([255]), {
          aad: new Uint8Array(),
          intent: 'ephemeral',
        })
      ).ciphertext
      const valid = await remote.encrypt(message())
      await fixture.drainMaintenance()
      const transactions = fixture.transactions()
      const receive = vi.spyOn(access, 'receive')
      const results = await Promise.allSettled([
        local.decrypt(malformed),
        local.decrypt(new Uint8Array([0])),
        local.decrypt(valid),
      ])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'fulfilled'])
      const opened: Array<ReceiveResult> | undefined = await receive.mock.results[0]?.value
      expect(opened?.filter((result) => result.kind === 'opened')).toHaveLength(2)
      expect(fixture.transactions()).toBe(transactions)
      expect(
        await access.receive([{ ciphertext: malformed, expectedAAD: new Uint8Array() }]),
      ).toEqual([{ kind: 'refused', reason: 'consumed' }])
    })

    test('concurrent encrypt and decrypt preserve both members ratchets', async () => {
      const { local, remote } = await setup()
      let forLocal = await remote.encrypt(message('request', 'b-init'))
      let forRemote = await local.encrypt(message('request', 'a-init'))
      for (let index = 0; index < 10; index++) {
        const [localOpened, localSent] = await Promise.all([
          local.decrypt(forLocal),
          local.encrypt(message('request', `a${index}`, 'session', index + 1)),
        ])
        const [remoteOpened, remoteSent] = await Promise.all([
          remote.decrypt(forRemote),
          remote.encrypt(message('request', `b${index}`, 'session', index + 1)),
        ])
        expect(decodeFrame(localOpened)).toEqual(
          decodeFrame(
            message('request', index === 0 ? 'b-init' : `b${index - 1}`, 'session', index),
          ),
        )
        expect(decodeFrame(remoteOpened)).toEqual(
          decodeFrame(
            message('request', index === 0 ? 'a-init' : `a${index - 1}`, 'session', index),
          ),
        )
        forLocal = remoteSent
        forRemote = localSent
      }
      expect(await local.decrypt(forLocal)).toEqual(message('request', 'b9', 'session', 10))
      expect(await remote.decrypt(forRemote)).toEqual(message('request', 'a9', 'session', 10))
    })

    test('only outstanding dialer replies survive rotation; result and error retire requests', async () => {
      const { fixture, local, remote } = await setup('dialer')
      for (const typ of ['request', 'stream', 'channel']) await local.encrypt(message(typ, typ))
      const receive = await remote.encrypt(message('receive', 'stream'))
      const result = await remote.encrypt(message('result', 'request'))
      const error = await remote.encrypt(message('error', 'channel'))
      const wrong = await remote.encrypt(message('result', 'other'))
      const lateResult = await remote.encrypt(message('receive', 'request'))
      const lateError = await remote.encrypt(message('receive', 'channel'))
      await fixture.advanceEpoch()
      await expect(local.decrypt(wrong)).rejects.toThrow('not an outstanding reply')
      expect(await local.decrypt(receive)).toEqual(message('receive', 'stream'))
      expect(await local.decrypt(result)).toEqual(message('result', 'request'))
      expect(await local.decrypt(error)).toEqual(message('error', 'channel'))
      await expect(local.decrypt(lateResult)).rejects.toThrow('not an outstanding reply')
      await expect(local.decrypt(lateError)).rejects.toThrow('not an outstanding reply')
    })

    test('listener rejects an old epoch even after an established request', async () => {
      const { fixture, local, remote } = await setup()
      expect(await local.decrypt(await remote.encrypt(message()))).toEqual(message())
      const stale = await remote.encrypt(message('receive'))
      await fixture.advanceEpoch()
      await expect(local.decrypt(stale)).rejects.toThrow('not an outstanding reply')
    })

    test('abort, local and remote session end, failed publish and clear retire dialer requests', async () => {
      const { fixture, local, remote, params } = await setup('dialer')
      for (const session of ['aborted', 'ended', 'remote-ended', 'late-ended', 'failed', 'cleared'])
        await local.encrypt(message('channel', 'rid', session))
      await local.encrypt(message('abort', 'rid', 'aborted'))
      await local.encrypt(sessionEnd('ended'))
      expect(await local.decrypt(await remote.encrypt(sessionEnd('remote-ended')))).toEqual(
        sessionEnd('remote-ended'),
      )
      const lateEnd = await remote.encrypt(sessionEnd('late-ended'))
      const failed = await local.encrypt(message('channel', 'failed', 'failed'))
      const failure = new Error('hub publish failed')
      const hub = {
        publish: vi.fn(async () => {
          throw failure
        }),
      } as unknown as MailboxHub
      await expect(
        local.trackPublish(hub).publish({
          senderDID: params.peerDID,
          topicID: 'topic',
          payload: encodeEnvelope({
            v: 1,
            groupID: fixture.key.groupID,
            ciphertext: toB64(failed),
          }),
        }),
      ).rejects.toBe(failure)
      const replies = []
      for (const session of ['aborted', 'ended', 'remote-ended', 'late-ended', 'failed'])
        replies.push(
          await remote.encrypt(
            message('receive', session === 'failed' ? 'failed' : 'rid', session),
          ),
        )
      await fixture.advanceEpoch()
      await expect(local.decrypt(lateEnd)).rejects.toThrow('not an outstanding reply')
      for (const reply of replies)
        await expect(local.decrypt(reply)).rejects.toThrow('not an outstanding reply')
      const cleared = await remote.encrypt(message('receive', 'rid', 'cleared'))
      await fixture.advanceEpoch()
      local.clear()
      await expect(local.decrypt(cleared)).rejects.toThrow('not an outstanding reply')
    })

    test('completion removes pending publication tracking before a request ID is reused', async () => {
      const { fixture, local, remote, params } = await setup('dialer')
      const completed = await local.encrypt(message())
      expect(await local.decrypt(await remote.encrypt(message('result')))).toEqual(
        message('result'),
      )
      await local.encrypt(message())
      const reply = await remote.encrypt(message('receive'))
      const failure = new Error('publish failed')
      const hub = {
        publish: async () => {
          throw failure
        },
      } as unknown as MailboxHub
      await expect(
        local.trackPublish(hub).publish({
          senderDID: params.peerDID,
          topicID: 'topic',
          payload: encodeEnvelope({
            v: 1,
            groupID: fixture.key.groupID,
            ciphertext: toB64(completed),
          }),
        }),
      ).rejects.toBe(failure)
      await fixture.advanceEpoch()
      expect(await local.decrypt(reply)).toEqual(message('receive'))
    })

    test('removed peer cannot open an old epoch request and closes once', async () => {
      const { fixture, local, remote } = await setup()
      const stale = await remote.encrypt(message())
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.removePeer()
      await expect(local.decrypt(stale)).rejects.toThrow('no longer a group member')
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    })

    test('same-epoch unavailable snapshot closes once and clears outstanding requests', async () => {
      const { fixture, local, remote, access } = await setup('dialer')
      const epoch = access.runtime.snapshot()?.epoch
      await local.encrypt(message())
      const reply = await remote.encrypt(message('receive'))
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.setUnavailable()
      expect(access.runtime.snapshot()).toMatchObject({ epoch, available: false })
      expect(dispose).toHaveBeenCalledOnce()
      await expect(local.decrypt(reply)).rejects.toThrow()
      await fixture.setUnavailable()
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    })

    test('initially unavailable snapshot closes immediately', async () => {
      const { fixture, local } = await setup()
      await fixture.setUnavailable()
      const dispose = vi.fn(async () => {})
      local.watchPeerRemoval(dispose)()
      expect(dispose).toHaveBeenCalledOnce()
    })

    test('version-only writes and sequential rotations keep watching until unsubscribed', async () => {
      const { fixture, local, access } = await setup()
      const initial = access.runtime.snapshot()
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.writeElsewhere('receive')
      expect(access.runtime.snapshot()?.stateVersion).toBeGreaterThan(initial?.stateVersion ?? 0)
      expect(access.runtime.snapshot()?.epoch).toBe(initial?.epoch)
      await fixture.advanceEpoch()
      await fixture.advanceEpoch()
      expect(dispose).not.toHaveBeenCalled()
      unwatch()
      await fixture.setUnavailable()
      expect(dispose).not.toHaveBeenCalled()
    })

    test('an observed epoch jump closes once', async () => {
      const { fixture, access, params } = await setup()
      let notify: ((value: GroupRuntimeSnapshot | null) => void) | undefined
      const local = new MLSEncryptor({
        ...params,
        access: {
          ...access,
          runtime: {
            snapshot: access.runtime.snapshot,
            onEpochChanged: (listener) => {
              notify = listener
              return () => {
                notify = undefined
              }
            },
          },
        },
      })
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.jumpEpochs(2)
      notify?.(access.runtime.snapshot())
      notify?.(access.runtime.snapshot())
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    })

    test('incarnation switch closes once', async () => {
      const { fixture, local } = await setup()
      const dispose = vi.fn(async () => {})
      const unwatch = local.watchPeerRemoval(dispose)
      await fixture.switchIncarnation()
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    })

    test('encrypt at the generation bound refuses', async () => {
      const { fixture, local } = await setup()
      await fixture.forceStoredGeneration(500)
      await expect(local.encrypt(message())).rejects.toThrow()
    })
  })
}

// Exercise adapter boundaries without manufacturing MLS cryptography.
function controlledAccess() {
  const peerDID = 'did:test:peer'
  let snapshot: GroupRuntimeSnapshot | null = {
    groupID: 'controlled',
    incarnation: 1,
    epoch: 1,
    authenticator: new Uint8Array([1]),
    members: new Set([peerDID]),
    available: true,
    stateVersion: 1,
  }
  let listener: ((value: GroupRuntimeSnapshot | null) => void) | undefined
  const access: MLSEncryptorParams['access'] = {
    key: { groupID: 'controlled', incarnation: 1 },
    seal: vi.fn(async (ciphertext) => ({ ciphertext, epoch: 1, generation: 0 })),
    receive: vi.fn<MLSEncryptorParams['access']['receive']>(async (frames) =>
      frames.map(
        ({ ciphertext }): ReceiveResult => ({
          kind: 'opened',
          payload: ciphertext,
          senderDID: peerDID,
          aad: new Uint8Array(),
          frameEpoch: 1,
          handleEpoch: 1,
        }),
      ),
    ),
    runtime: {
      snapshot: () => snapshot,
      onEpochChanged: (next) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
    },
  }
  return {
    access,
    peerDID,
    publish: (value: GroupRuntimeSnapshot | null) => {
      snapshot = value
      listener?.(value)
    },
  }
}

test('receive chunks contain at most 64 unique inputs', async () => {
  const { access, peerDID } = controlledAccess()
  const local = new MLSEncryptor({ access, peerDID, role: 'listener' })
  const frames = Array.from({ length: 130 }, (_, index) => message('request', `${index}`))
  expect(await Promise.all(frames.map((frame) => local.decrypt(frame)))).toEqual(frames)
  expect(vi.mocked(access.receive).mock.calls.map(([chunk]) => chunk.length)).toEqual([64, 64, 2])
})

for (const invalid of ['null', 'missing-peer', 'throwing-members', 'throwing-snapshot'] as const) {
  test(`watch closes once on ${invalid}, initially and after subscription`, () => {
    for (const initial of [true, false]) {
      const { access, peerDID, publish } = controlledAccess()
      const local = new MLSEncryptor({ access, peerDID, role: 'dialer' })
      const dispose = vi.fn(async () => {
        throw new Error('dispose failed')
      })
      const value = access.runtime.snapshot()
      if (value === null) throw new Error('Missing snapshot')
      const broken =
        invalid === 'null'
          ? null
          : {
              ...value,
              members:
                invalid === 'throwing-members'
                  ? ({
                      has: () => {
                        throw new Error('membership failed')
                      },
                    } as unknown as ReadonlySet<string>)
                  : new Set<string>(),
            }
      if (invalid === 'throwing-snapshot')
        access.runtime.snapshot = () => {
          throw new Error('snapshot failed')
        }
      if (initial) publish(broken)
      const unwatch = local.watchPeerRemoval(dispose)
      if (!initial) {
        publish(broken)
        publish(broken)
      }
      expect(dispose).toHaveBeenCalledOnce()
      unwatch()
    }
  })
}

test('nameless frames require outstanding dialer replies and non-opened items reject', async () => {
  const { access, peerDID } = controlledAccess()
  const receive = vi.mocked(access.receive)
  receive.mockImplementation(async (frames) =>
    frames.map(({ ciphertext }) => ({
      kind: 'opened',
      payload: ciphertext,
      aad: new Uint8Array(),
      frameEpoch: 1,
      handleEpoch: 1,
    })),
  )
  const local = new MLSEncryptor({ access, peerDID, role: 'dialer' })
  await expect(local.decrypt(message('receive'))).rejects.toThrow('not an outstanding reply')
  await local.encrypt(message())
  expect(await local.decrypt(message('receive'))).toEqual(message('receive'))
  receive.mockResolvedValue([{ kind: 'refused', reason: 'capacity' }])
  await expect(local.decrypt(message())).rejects.toThrow()
  receive.mockRejectedValue(new Error('receive failed'))
  await expect(local.decrypt(message())).rejects.toThrow('receive failed')
})

test('an observed removal clears requests even when the peer is re-added', async () => {
  const { access, peerDID, publish } = controlledAccess()
  const local = new MLSEncryptor({ access, peerDID, role: 'dialer' })
  await local.encrypt(message())
  const dispose = vi.fn(async () => {})
  const unwatch = local.watchPeerRemoval(dispose)
  const initial = access.runtime.snapshot()
  if (initial === null) throw new Error('Missing snapshot')
  publish({ ...initial, epoch: 2, members: new Set() })
  publish({ ...initial, epoch: 3 })
  vi.mocked(access.receive).mockResolvedValue([
    {
      kind: 'opened',
      payload: message('receive'),
      senderDID: peerDID,
      aad: new Uint8Array(),
      frameEpoch: 1,
      handleEpoch: 3,
    },
  ])
  await expect(local.decrypt(message('receive'))).rejects.toThrow('not an outstanding reply')
  expect(dispose).toHaveBeenCalledOnce()
  unwatch()
})

test('successful and malformed hub publications are forwarded unchanged', async () => {
  const { access, peerDID } = controlledAccess()
  const local = new MLSEncryptor({ access, peerDID, role: 'dialer' })
  const ciphertext = await local.encrypt(message())
  const publish = vi.fn(async () => '1-0')
  const hub = { publish } as unknown as MailboxHub
  const tracked = local.trackPublish(hub)
  for (const payload of [
    new Uint8Array([0]),
    encodeEnvelope({ v: 1, groupID: 'controlled', ciphertext: toB64(ciphertext) }),
  ]) {
    const params = { senderDID: peerDID, topicID: 'topic', payload }
    await expect(tracked.publish(params)).resolves.toBe('1-0')
    expect(publish).toHaveBeenLastCalledWith(params)
  }
})

test('a direct incarnation change closes once without a null notification', () => {
  const { access, peerDID, publish } = controlledAccess()
  const local = new MLSEncryptor({ access, peerDID, role: 'dialer' })
  const dispose = vi.fn(async () => {})
  const unwatch = local.watchPeerRemoval(dispose)
  const initial = access.runtime.snapshot()
  if (initial === null) throw new Error('Missing snapshot')
  publish({ ...initial, incarnation: initial.incarnation + 1 })
  publish({ ...initial, incarnation: initial.incarnation + 1 })
  expect(dispose).toHaveBeenCalledOnce()
  unwatch()
})
