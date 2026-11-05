import {
  type AdoptionExpected,
  type AppOutboxEntry,
  type AppPublicationSnapshot,
  assertFrameFits,
  decodeAppEntry,
  encodeAppAAD,
  type PreparedAppPublication,
  protocolTopic,
} from '@kumiai/rpc'

import { type EntryCapability, type EntryReads, entryReadsAttempt } from '../entry-capability.js'
import { copyStoredValue, sameStoredValue } from '../memory-incarnation-stores.js'
import {
  DisplacedGroupHandleError,
  GroupStateConflictError,
  GroupUnavailableError,
  RegistryRetiringError,
  StorageOutcomeUnknownError,
} from '../persistence-errors.js'
import type { GroupStores, GroupTransaction } from '../persistence-types.js'
import type { RegistryOwner } from './access.js'
import type { createLiveSend } from './live-send.js'
import { committedNext } from './live-send.js'
import { readSourceAdmission } from './source-command-runtime.js'
import { sourceCryptoScope } from './source-crypto-commands.js'
import type { SourceBinding } from './source-executor-types.js'
import type { RegistryHandleAccess } from './types.js'

export function createPublicationPreparation<TTx extends GroupTransaction>(params: {
  owner: RegistryOwner
  binding: object
  capability: EntryCapability<TTx>
  live: ReturnType<typeof createLiveSend<TTx>>
  assertAvailable(): void
  assertSourceBinding(binding: SourceBinding): void
  assertCurrent(): void
  assertWorkSafety(stores: GroupStores<TTx>): Promise<void>
  resolve(mutationID: string): Promise<'committed' | 'rolled-back'>
  diagnoseFailure(error: unknown): Promise<void>
  publish(): void
}): Pick<RegistryHandleAccess, 'assertPublicationEntry'> & {
  publicationSnapshot(
    protocol: string,
    binding: SourceBinding,
  ): Promise<AppPublicationSnapshot | null>
  preparePublication(
    entry: AppOutboxEntry,
    floor: string | null,
    expected: AdoptionExpected | undefined,
    binding: SourceBinding,
  ): Promise<PreparedAppPublication>
} {
  const { owner, capability, live } = params
  const n = owner.key.incarnation
  async function snapshot(
    reads: EntryReads,
    protocol: string,
    binding: SourceBinding,
  ): Promise<AppPublicationSnapshot | null> {
    params.assertSourceBinding(binding)
    params.assertAvailable()
    const life = await reads.lifetime()
    await readSourceAdmission(reads, owner.key)
    const record = await reads.state(n)
    const slot = await reads.anchor(n)
    if (
      live.unresolved() ||
      life?.activeIncarnation !== n ||
      record === null ||
      record.deleted ||
      record.state === null ||
      record.terminal ||
      slot === null ||
      slot.pending !== undefined
    )
      return null
    return {
      identity: {
        ...owner.key,
        epoch: record.epoch,
        authenticator: Uint8Array.from(record.epochAuthenticator),
      },
      stateVersion: record.version,
      sealVersion: live.frontier(),
      segment: slot.anchor.epoch,
      topicID: protocolTopic(slot.anchor.secret, slot.anchor.epoch, protocol),
    }
  }
  async function publicationSnapshot(
    protocol: string,
    binding: SourceBinding,
  ): Promise<AppPublicationSnapshot | null> {
    capability.assertRoot()
    if (live.pendingProof()) return null
    try {
      return await capability.read(owner.key.groupID, (reads) => snapshot(reads, protocol, binding))
    } catch (error) {
      if (
        error instanceof DisplacedGroupHandleError ||
        error instanceof RegistryRetiringError ||
        error instanceof GroupUnavailableError
      )
        return null
      throw error
    }
  }
  async function preparePublication(
    input: AppOutboxEntry,
    floor: string | null,
    admitted: AdoptionExpected | undefined,
    binding: SourceBinding,
  ): Promise<PreparedAppPublication> {
    capability.assertRoot()
    const entry = copyStoredValue(input)
    decodeAppEntry(entry)
    // Capture before waiting for an owner; queued movement cannot silently change the source.
    const source = live.committedRecord
    const expected = admitted ?? {
      identity: {
        ...owner.key,
        epoch: source.epoch,
        authenticator: Uint8Array.from(source.epochAuthenticator),
      },
      stateVersion: source.version,
    }
    return await (async () => {
      const mutationID = crypto.randomUUID()
      let result: PreparedAppPublication | undefined
      try {
        await live.run(
          { groupID: owner.key.groupID, mutationID },
          async (reads) => {
            const captured = await snapshot(reads, entry.protocol, binding)
            if (
              captured === null ||
              !sameStoredValue(captured.identity, expected.identity) ||
              captured.stateVersion !== expected.stateVersion
            )
              throw new GroupStateConflictError('Publication source moved')
            const current = (await reads.outbox(n)).find((row) => row.seq === entry.seq)
            if (!sameStoredValue(current, entry) || entry.status !== 'accepted')
              throw new GroupStateConflictError('Publication entry moved')
            if ((await reads.settlement(n, entry.seq)) !== null)
              throw new GroupStateConflictError('Publication entry is obligated')
            const record = await reads.state(n)
            if (record === null || record.deleted || record.state === null)
              throw new GroupStateConflictError('Publication state unavailable')
            const sealed = await live.prepareSeal(
              { ...record, state: record.state },
              entry.data,
              encodeAppAAD({ topicID: captured.topicID, intent: 'log' }),
              sourceCryptoScope(entryReadsAttempt(reads), () => {
                params.assertSourceBinding(binding)
                params.assertAvailable()
              }),
            )
            assertFrameFits(sealed.sealed.ciphertext)
            const updated: AppOutboxEntry = {
              ...entry,
              lastAttempt: {
                incarnation: n,
                epoch: captured.identity.epoch,
                floor,
                attempts: (entry.lastAttempt?.attempts ?? 0) + 1,
                publishID: crypto.randomUUID(),
                segment: captured.segment,
                topicID: captured.topicID,
              },
            }
            result = {
              entry: updated,
              payload: Uint8Array.from(sealed.sealed.ciphertext),
              snapshot: {
                ...captured,
                stateVersion: sealed.record.version,
                sealVersion: live.frontier(),
              },
            }
            return {
              expected: await reads.lifetime(),
              value: { ...sealed, source: captured, entry: updated },
            }
          },
          async (stores, prepared) => {
            params.assertAvailable()
            params.assertCurrent()
            await params.assertWorkSafety(stores)
            const rows = stores.incarnation(n)
            const record = await rows.state.load()
            const anchor = await rows.anchor.load()
            const current = (await rows.outbox.list()).find((row) => row.seq === entry.seq)
            if (
              record === null ||
              record.deleted ||
              record.version !== prepared.source.stateVersion ||
              record.epoch !== prepared.source.identity.epoch ||
              !sameStoredValue(record.epochAuthenticator, prepared.source.identity.authenticator) ||
              anchor === null ||
              anchor.pending !== undefined ||
              protocolTopic(anchor.anchor.secret, anchor.anchor.epoch, entry.protocol) !==
                prepared.source.topicID ||
              !sameStoredValue(current, entry) ||
              (await rows.meta.loadSettlement(entry.seq)) !== null
            )
              throw new GroupStateConflictError('Publication source moved before commit')
            if (committedNext(prepared.record) < prepared.publicationCopy.limit)
              throw new GroupStateConflictError('Publication lease is not committed')
            if (prepared.record.version !== record.version) await rows.state.save(prepared.record)
            await rows.outbox.put([prepared.entry])
          },
        )
      } catch (error) {
        if (
          !(error instanceof StorageOutcomeUnknownError) ||
          (await params.resolve(mutationID)) !== 'committed'
        ) {
          await params.diagnoseFailure(error)
          throw error
        }
      } finally {
        params.publish()
      }
      if (result === undefined) throw new GroupStateConflictError('Publication was not prepared')
      return copyStoredValue(result)
    })()
  }
  return {
    assertPublicationEntry: () => capability.assertRoot(),
    preparePublication,
    publicationSnapshot,
  }
}
