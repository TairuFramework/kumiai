import {
  type CertifiedFinalisationResult,
  coordinatorBinding,
  type EntryCapability,
  entryCapability,
} from './entry-capability.js'
import { groupBatchFor } from './group-batch-binding.js'
import { statusEventID } from './memory-incarnation-stores.js'
import { GroupStateConflictError } from './persistence-errors.js'
import type {
  GroupKey,
  GroupPersistence,
  GroupStores,
  GroupTransaction,
} from './persistence-types.js'

export async function finaliseCertifiedAppInTransaction<TTx extends GroupTransaction>(params: {
  stores: GroupStores<TTx>
  key: GroupKey
  seq: number
  mutationID: string
}): Promise<CertifiedFinalisationResult> {
  const { stores, key, seq, mutationID } = params
  const rows = stores.incarnation(key.incarnation)
  const obligation = await rows.meta.loadSettlement(seq)
  const saved = (await rows.outbox.list()).find((value) => value.seq === seq)
  if (saved === undefined && obligation === null) return { seq, status: 'already-complete' }
  const attempt = saved?.lastAttempt
  if (
    saved === undefined ||
    saved.status !== 'accepted' ||
    obligation === null ||
    obligation.outcome !== 'published' ||
    attempt == null ||
    attempt.incarnation !== key.incarnation ||
    attempt.publishID !== obligation.attemptID ||
    attempt.topicID !== obligation.topicID
  )
    throw new GroupStateConflictError(
      'Certified finalisation requires the original obligation and attempt',
    )
  await rows.meta.putEvents([
    {
      ...key,
      id: statusEventID(mutationID, seq, 'published'),
      kind: 'published',
      entry: saved,
      occurrence: {
        incarnation: attempt.incarnation,
        segment: attempt.segment,
        topicID: attempt.topicID,
        position: obligation.sequenceID,
      },
    },
  ])
  await rows.outbox.remove([seq])
  return { seq, status: 'published' }
}

type Request = { seqs: Array<number>; resolve(): void; reject(error: unknown): void }
const collectors = new WeakMap<object, Map<string, (seqs: Array<number>) => Promise<void>>>()
export function collectCertifiedApps<TTx extends GroupTransaction>(params: {
  capability: EntryCapability<TTx>
  binding: object
  key: GroupKey
  seqs: Array<number>
}): Promise<void> {
  const { capability, binding } = params
  capability.assertRoot()
  const key = { ...params.key }
  let groups = collectors.get(binding)
  if (groups === undefined) {
    groups = new Map()
    collectors.set(binding, groups)
  }
  const id = JSON.stringify([key.groupID, key.incarnation])
  let collect = groups.get(id)
  if (collect === undefined) {
    const scheduler = groupBatchFor(binding, key.groupID)
    const waiting: Array<Request> = []
    let active = false
    const pump = () => {
      if (active || waiting.length === 0) return
      active = true
      let selected: Array<Request> = []
      void scheduler
        .schedule({
          source: JSON.stringify(['settlement', key.incarnation]),
          kind: 'settlement',
          signal: capability.failureSignal,
          run: async (budget) => {
            selected = waiting.splice(0)
            const seqs = selected.flatMap((request) => request.seqs)
            return capability.finaliseCertifiedAppBatch(key, seqs, budget)
          },
        })
        .then(
          ({ consumed }) => {
            let left = consumed
            const suffix: Array<Request> = []
            for (const request of selected) {
              const count = Math.min(left, request.seqs.length)
              left -= count
              request.seqs = request.seqs.slice(count)
              if (request.seqs.length === 0) request.resolve()
              else suffix.push(request)
            }
            waiting.unshift(...suffix)
          },
          (error: unknown) => {
            for (const request of selected.length === 0 ? waiting.splice(0) : selected)
              request.reject(error)
          },
        )
        .finally(() => {
          active = false
          pump()
        })
    }
    collect = (seqs) =>
      new Promise<void>((resolve, reject) => {
        if (seqs.length === 0) {
          resolve()
          return
        }
        waiting.push({ seqs: [...seqs], resolve, reject })
        pump()
      })
    groups.set(id, collect)
  }
  return collect(params.seqs)
}

export async function finaliseAppSettlements<TTx extends GroupTransaction>(params: {
  persistence: GroupPersistence<TTx>
  key: GroupKey
}): Promise<void> {
  const capability = entryCapability(params.persistence)
  const binding = coordinatorBinding(params.persistence)
  if (capability === null || binding === null)
    throw new GroupStateConflictError('Settlement service requires registered entry capability')
  capability.assertRoot()
  return readySettlements(params, capability, binding)
}

async function readySettlements<TTx extends GroupTransaction>(
  params: {
    persistence: GroupPersistence<TTx>
    key: GroupKey
  },
  capability: EntryCapability<TTx>,
  binding: object,
): Promise<void> {
  const key = { ...params.key }
  const entries = await capability.read(key.groupID, async (reads) => {
    const entries = await reads.outbox(key.incarnation)
    const certified = []
    for (const entry of entries) {
      // Legacy markers without an attempt cannot supply a publication occurrence.
      if (
        entry.lastAttempt !== null &&
        (await reads.settlement(key.incarnation, entry.seq)) !== null
      )
        certified.push(entry)
    }
    return certified
  })
  await collectCertifiedApps({ capability, binding, key, seqs: entries.map((entry) => entry.seq) })
}
