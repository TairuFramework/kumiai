import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  commitLedgerEntries,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  ledgerEntryDigest,
  restoreGroup,
  signLedgerEntry,
} from '@kumiai/mls'
import {
  type AnchorStore,
  type AppCursorStore,
  type AppOutbox,
  CommitDeadlineError,
  type CommitJournal,
  commitTopic,
  createGroupPeer,
  encodeCommitFrame,
  encodeHandshakeFrame,
  encodeLedgerEntries,
  type GroupPeerParams,
  HANDSHAKE_KIND,
} from '@kumiai/rpc'
import {
  createCommit,
  decode,
  encode,
  mlsMessageDecoder,
  mlsMessageEncoder,
  wireformats,
} from 'ts-mls'
import { expect, test } from 'vitest'

import { simpleHandleAccess } from '../src/access.js'
import { createGroupCrypto } from '../src/crypto.js'
import { createGroupMLS } from '../src/mls.js'
import { createRealGroup } from './fixtures/real-group.js'

type Hub = GroupPeerParams<Record<string, never>>['hub']

// Reuse the same CAS hub and durable stores as the orchestration suite without a package cycle.
const fixture = async (name: string) =>
  await import(new URL(`../../rpc/test/fixtures/${name}.ts`, import.meta.url).href)
const { FakeHub } = (await fixture('fake-hub')) as { FakeHub: new () => Hub }
const { createMemoryCommitJournal } = (await fixture('journal')) as {
  createMemoryCommitJournal: () => CommitJournal
}
const { createMemoryAnchorStore } = (await fixture('anchor')) as {
  createMemoryAnchorStore: () => AnchorStore
}
const { createMemoryAppCursorStore } = (await fixture('app-cursor')) as {
  createMemoryAppCursorStore: () => AppCursorStore
}
const { createMemoryAppOutbox } = (await fixture('outbox')) as {
  createMemoryAppOutbox: () => AppOutbox
}

// Inspect actual encrypted sender-data, rather than trusting a modelled generation counter.
const entry = createRequire(import.meta.url).resolve('ts-mls')
const { decryptSenderData } = (await import(
  new URL('./privateMessage.js', pathToFileURL(entry)).href
)) as {
  decryptSenderData: (
    message: unknown,
    secret: Uint8Array,
    suite: unknown,
  ) => Promise<{ generation: number } | undefined>
}

async function generation(group: GroupHandle, frame: Uint8Array): Promise<number> {
  const message = decode(mlsMessageDecoder, frame)
  if (message?.wireformat !== wireformats.mls_private_message) throw new Error('not private')
  const sender = await decryptSenderData(
    message.privateMessage,
    group.state.keySchedule.senderDataSecret,
    group.context.cipherSuite,
  )
  if (sender == null) throw new Error('missing sender data')
  return sender.generation
}

for (const winner of ['policy-refused', 'historical', 'malformed', 'applied'] as const) {
  test.each([false, true])(
    `a ${winner} CAS winner permits fresh builds (restart: %s)`,
    async (restart) => {
      const group = await createRealGroup(1, `cas-${winner}-${restart}`)
      const author = group.committer
      const observer = group.members[0]
      if (observer == null) throw new Error('missing observer')
      const credential = author.handle.credential
      const ledger = author.handle.ledgerTokens
      const epoch = author.handle.epoch
      const historical = (
        await createCommit({
          context: author.handle.context,
          state: {
            ...author.handle.state,
            groupContext: { ...author.handle.state.groupContext, epoch: epoch - 1n },
          },
        })
      ).commit
      const competing = await createCommit({
        context: observer.handle.context,
        state: observer.handle.state,
      })
      const competitor =
        winner === 'malformed'
          ? new Uint8Array()
          : encode(mlsMessageEncoder, winner === 'historical' ? historical : competing.commit)
      const hub = new FakeHub()
      const journal = createMemoryCommitJournal()
      const anchorStore = createMemoryAnchorStore()
      const appCursorStore = createMemoryAppCursorStore()
      const appOutbox = createMemoryAppOutbox()
      const secret = new Uint8Array(32).fill(0x62)
      let saved = encodeClientState(author.handle.state)
      let publishes = 0
      let failSave = false
      const makeAccess = () =>
        simpleHandleAccess({
          handle: () => author.handle,
          adopt: (next) => {
            author.handle = next
          },
          persist: (handle) => {
            if (failSave) throw new Error('disk failed')
            saved = encodeClientState(handle.state)
          },
        })
      let access = makeAccess()
      let crypto = createGroupCrypto({ access })
      const makeMLS = () =>
        createGroupMLS({
          access,
          identity: author.identity,
          entrySlot: author.slot,
          recoverySecret: async () => secret,
        })
      let mls = makeMLS()
      // Refuse only received commits. Outgoing authoring retains its normal policy.
      if (winner === 'policy-refused') {
        const state = decodeClientState(saved)
        if (state == null) throw new Error('invalid state')
        author.handle = await restoreGroup({
          state,
          credential,
          ledgerEntries: ledger,
          options: { commitPolicy: () => 'reject' },
        })
      }
      const view: Hub = {
        publish: async (params) => {
          if (params.publishID != null && ++publishes === 1) {
            const { sealed } = await crypto.sealEntries(encodeLedgerEntries([]))
            await hub.publish({
              senderDID: observer.identity.id,
              topicID: commitTopic(secret),
              retain: 'log',
              payload: encodeHandshakeFrame(
                HANDSHAKE_KIND.commit,
                encodeCommitFrame(competitor, sealed),
              ),
            })
          }
          return await hub.publish(params)
        },
        subscribe: (...args) => hub.subscribe(...args),
        unsubscribe: async (...args) => {
          await hub.unsubscribe?.(...args)
        },
        receive: (...args) => hub.receive(...args),
        fetchTopic: (...args) => hub.fetchTopic(...args),
      }
      const makePeer = (first: boolean) =>
        createGroupPeer({
          hub: view,
          crypto,
          mls,
          journal,
          anchorStore,
          appCursorStore,
          appOutbox,
          appOutboxLimit: 128,
          localDID: author.identity.id,
          protocols: {},
          handlers: {},
          adoptJournalled: async () => {},
          ...(restart && first ? { commitDeadlineMs: 0 } : {}),
        })
      const token = await signLedgerEntry(author.identity, {
        type: 'test.value',
        groupID: author.handle.groupID,
        subject: author.identity.id,
        value: 'landed',
      })
      const frames: Array<{ epoch: bigint; generation: number; commit: Uint8Array }> = []
      const build = async () => {
        const source = author.handle
        const built = await commitLedgerEntries(source, [token])
        frames.push({
          epoch: source.epoch,
          generation: await generation(source, built.commitMessage),
          commit: built.commitMessage,
        })
        return {
          commit: built.commitMessage,
          bodies: [token],
          kind: 'ledger' as const,
          journal: encodeClientState(built.newGroup.state),
          onAccepted: async () => {
            await access.replace(built.newGroup)
          },
        }
      }
      let peer = makePeer(true)
      try {
        if (restart) {
          await expect(peer.commit(build)).rejects.toThrow(CommitDeadlineError)
          expect(await journal.get()).toBeNull()
          await peer.dispose()
          const state = decodeClientState(saved)
          if (state == null) throw new Error('invalid saved state')
          author.handle = await restoreGroup({
            state,
            credential,
            ledgerEntries: ledger,
            options: {
              ...(winner === 'policy-refused' ? { commitPolicy: () => 'reject' as const } : {}),
              resolveLedgerEntries: author.slot.resolve,
            },
          })
          access = makeAccess()
          crypto = createGroupCrypto({ access })
          mls = makeMLS()
          peer = makePeer(false)
        }
        await expect(peer.commit(build)).resolves.toEqual({})
        expect(frames.map((frame) => frame.epoch)).toEqual(
          winner === 'applied' ? [epoch, epoch + 1n] : [epoch, epoch],
        )
        if (winner !== 'applied')
          expect(frames[1]?.generation).toBeGreaterThan(frames[0]?.generation ?? -1)
        expect(author.handle.epoch).toBe(epoch + (winner === 'applied' ? 2n : 1n))
        expect(author.handle.ledgerTokens).toContain(token)
        expect(await journal.get()).toBeNull()
        // The surviving frame also applies at an independent receiver across the skipped key.
        if (winner === 'applied') {
          observer.handle = await restoreGroup({
            state: competing.newState,
            credential: observer.handle.credential,
            ledgerEntries: observer.handle.ledgerTokens,
            options: { resolveLedgerEntries: observer.slot.resolve },
          })
        }
        group.bodies.set(ledgerEntryDigest(token), token)
        const landed = frames[1]?.commit
        if (landed == null) throw new Error('missing retry')
        await observer.handle.processMessage(landed)
        expect(observer.handle.ledgerTokens).toContain(token)
        expect(observer.handle.epoch).toBe(author.handle.epoch)
        // Persistence failure prevents the caller from framing any new ciphertext.
        failSave = true
        await expect(peer.commit(build)).rejects.toThrow('disk failed')
        expect(frames).toHaveLength(2)
      } finally {
        await peer.dispose()
      }
    },
  )
}
