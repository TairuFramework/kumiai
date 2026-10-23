import type { AppOutbox } from '../../src/app-outbox.js'
import type { AppPublicationPort, AppPublicationSnapshot } from '../../src/app-publication.js'
import type { EpochFloor } from '../../src/log-delivery.js'
import { bindMemoryOutbox } from './outbox.js'

/** Unit model: the only mutable state is its floor and outbox. */
export function createWorkerPublication(params: {
  outbox: AppOutbox
  floor(): EpochFloor
  seal(): Promise<{ topicID: string; payload: Uint8Array; floor: EpochFloor }>
  put: AppOutbox['put']
}): AppPublicationPort {
  const key = { groupID: crypto.randomUUID(), incarnation: 1 }
  let sealVersion = 0
  const snapshot = (): AppPublicationSnapshot => ({
    identity: {
      ...key,
      epoch: params.floor().epoch,
      authenticator: new TextEncoder().encode(String(params.floor().epoch)),
    },
    stateVersion: 0,
    sealVersion,
    segment: params.floor().epoch,
    topicID: 'app',
  })
  Object.assign(key, bindMemoryOutbox(params.outbox, snapshot) ?? key)
  return {
    snapshot: async () => snapshot(),
    async prepare(entry, floor) {
      if ((await params.outbox.loadSettlement(entry.seq)) !== null)
        throw new Error('Obligated entry')
      const frame = await params.seal()
      sealVersion++
      const updated = {
        ...entry,
        lastAttempt: {
          incarnation: key.incarnation,
          epoch: frame.floor.epoch,
          floor,
          attempts: (entry.lastAttempt?.attempts ?? 0) + 1,
          publishID: crypto.randomUUID(),
          segment: frame.floor.epoch,
          topicID: frame.topicID,
        },
      }
      await params.put(updated)
      return { entry: updated, payload: frame.payload.slice(), snapshot: snapshot() }
    },
  }
}
