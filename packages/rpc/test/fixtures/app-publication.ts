import type { AnchorStore } from '../../src/anchor.js'
import { encodeAppAAD } from '../../src/app-aad.js'
import { decodeAppEntry } from '../../src/app-entry.js'
import type { AppOutbox, AppOutboxEntry } from '../../src/app-outbox.js'
import type { AppPublicationPort, AppPublicationSnapshot } from '../../src/app-publication.js'
import type { GroupCrypto } from '../../src/crypto.js'
import { assertFrameFits } from '../../src/frame-size.js'
import { protocolTopic } from '../../src/topic.js'
import type { MemoryGroupMLS } from './memory-group-mls.js'
import { createMemoryAppOutbox } from './outbox.js'

export function memoryApplicationPorts(
  mls: MemoryGroupMLS,
  crypto: GroupCrypto,
  suppliedOutbox?: AppOutbox,
  anchorStore: AnchorStore = mls.anchorStore(),
): { appOutbox: AppOutbox; appPublication: AppPublicationPort } {
  const key = mls.control().key
  const identity = () => ({ ...key, epoch: mls.epoch(), authenticator: mls.authenticator() })
  const appOutbox =
    suppliedOutbox ??
    createMemoryAppOutbox({
      key,
      snapshot: () => ({ identity: identity(), stateVersion: mls.stateVersion() }),
    })
  let sealVersion = 0
  const snapshot = async (protocol: string): Promise<AppPublicationSnapshot | null> => {
    const slot = await anchorStore.load()
    if (slot === null || slot.pending !== undefined) return null
    return {
      identity: identity(),
      stateVersion: mls.stateVersion(),
      sealVersion,
      segment: slot.anchor.epoch,
      topicID: protocolTopic(slot.anchor.secret, slot.anchor.epoch, protocol),
    }
  }
  return {
    appOutbox,
    appPublication: {
      snapshot: (protocol) => mls.publication(() => snapshot(protocol)),
      prepare(input, floor) {
        const entry = structuredClone(input)
        return mls.publication(async () => {
          decodeAppEntry(entry)
          const before = await snapshot(entry.protocol)
          if (before === null || !mls.sendAdmission().admissible)
            throw new Error('Publication unavailable')
          if ((await appOutbox.loadSettlement(entry.seq)) !== null)
            throw new Error('Obligated entry')
          const stored = (await appOutbox.list()).find((row) => row.seq === entry.seq)
          if (JSON.stringify(stored) !== JSON.stringify(entry) || entry.status !== 'accepted')
            throw new Error('Publication entry moved')
          const payload = await crypto.wrap(entry.data, {
            aad: encodeAppAAD({ topicID: before.topicID, intent: 'log' }),
          })
          assertFrameFits(payload)
          sealVersion++
          const after = await snapshot(entry.protocol)
          if (
            after === null ||
            JSON.stringify(before.identity) !== JSON.stringify(after.identity) ||
            before.topicID !== after.topicID
          )
            throw new Error('Publication source moved')
          const updated: AppOutboxEntry = {
            ...entry,
            lastAttempt: {
              incarnation: key.incarnation,
              epoch: before.identity.epoch,
              floor,
              attempts: (entry.lastAttempt?.attempts ?? 0) + 1,
              publishID: globalThis.crypto.randomUUID(),
              segment: before.segment,
              topicID: before.topicID,
            },
          }
          await appOutbox.put(updated)
          return { entry: updated, payload: payload.slice(), snapshot: after }
        })
      },
    },
  }
}
