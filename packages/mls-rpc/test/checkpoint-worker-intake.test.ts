import type { StoredMessage } from '@kumiai/hub-protocol'
import { type CheckpointService, createCheckpointWorker } from '@kumiai/rpc'
import { expect, test, vi } from 'vitest'

import { createAsyncLocalOwnershipContext } from './fixtures/ownership-context.js'
import { createForkNoticeFixture } from './fixtures/registry.js'

for (const mode of ['real-mls', 'double'] as const) {
  for (const ownership of ['supplied', 'absent'] as const) {
    const label = `${mode}, ${ownership}`
    const fixture = (deferSplit = false) =>
      createForkNoticeFixture({
        mode,
        deferSplit,
        ownershipContext: ownership === 'supplied' ? createAsyncLocalOwnershipContext() : undefined,
      })

    test(`identical heartbeat is compared after local coverage changes -- ${label}`, async () => {
      const f = await fixture(true)
      let clock = 10000
      let messages: Array<StoredMessage> = []
      let wake = () => {}
      const service = f.service()
      const compare = vi.spyOn(service, 'compare')
      const worker = createCheckpointWorker({
        key: f.key,
        checkpoints: service,
        recoverySecret: new Uint8Array(32),
        networkAllowed: () => true,
        now: () => clock,
        random: () => 0.5,
        mux: {
          onInbound: (_topic, listener) => {
            wake = () => {
              const message = messages[0]
              if (message === undefined) throw new Error('Missing checkpoint message')
              listener(message, () => {})
            }
            return () => {}
          },
          publish: async () => ({ sequenceID: '1' }),
          fetchTopic: async () => ({ messages, head: null, oldest: null, gap: false }),
        },
      })
      const deliver = async (position: string) => {
        messages = [
          { sequenceID: position, topicID: 'checkpoints', senderDID: 'relay', payload: f.frame },
        ]
        clock++
        wake()
        await worker.resume()
      }
      try {
        expect(await service.compare(f.key, f.frame)).toEqual({ kind: 'coverage-gap' })
        await worker.start()
        await deliver('0001')
        expect(await service.forkNotices(f.key.groupID)).toEqual([])
        await f.installSplit()
        expect(await service.compare(f.key, f.frame)).toMatchObject({ kind: 'conflict' })
        await deliver('0002')
        const notices = await service.forkNotices(f.key.groupID)
        expect(notices).toHaveLength(1)
        expect(f.emitted).toHaveLength(1)
        const writes = vi.spyOn(service, 'updateRecords')
        await deliver('0003')
        expect(await service.forkNotices(f.key.groupID)).toEqual(notices)
        expect(f.emitted).toHaveLength(1)
        // Duplicate suppression must avoid cryptographic intake with unchanged coverage.
        expect(
          writes.mock.calls
            .flatMap(([change]) => change.put ?? [])
            .some((row) => row.kind === 'cursor' && 'intake' in row && row.intake !== undefined),
        ).toBe(false)
        expect(compare).toHaveBeenCalledTimes(2)
      } finally {
        await worker.dispose()
        await f.close()
      }
    })

    test.each(['commit', 'rollback'] as const)(
      `receive cursor and fork evidence share crash resolution: %s -- ${label}`,
      async (outcome) => {
        const f = await fixture()
        const service = f.service()
        const update = service.updateRecords.bind(service)
        let fault: ReturnType<typeof f.holdProof> | undefined
        let reached = () => {}
        const rejected = new Promise<void>((resolve) => {
          reached = resolve
        })
        vi.spyOn(service, 'updateRecords').mockImplementation(async (change) => {
          if (
            fault === undefined &&
            change.put?.some((row) => row.kind === 'cursor' && row.position === '0001')
          ) {
            fault = f.holdProof()
            void fault.rejected.then(reached)
          }
          await update(change)
        })
        const create = (checkpoints: CheckpointService, now = 10000) =>
          createCheckpointWorker({
            key: f.key,
            checkpoints,
            recoverySecret: new Uint8Array(32),
            networkAllowed: () => true,
            now: () => now,
            random: () => 0.5,
            mux: {
              onInbound: () => () => {},
              publish: async () => ({ sequenceID: '1' }),
              fetchTopic: async () => ({
                messages: [
                  {
                    sequenceID: '0001',
                    topicID: 'checkpoints',
                    senderDID: 'relay',
                    payload: f.frame,
                  },
                ],
                head: '0001',
                oldest: '0001',
                gap: false,
              }),
            },
          })
        const worker = create(service)
        let restarted: ReturnType<typeof create> | undefined
        const starting = worker.start()
        let resolved = false
        try {
          await rejected
          expect(f.emitted).toEqual([])
          if (fault === undefined) throw new Error('Missing transaction fault')
          await fault.finish(outcome)
          resolved = true
          await starting
          await worker.dispose()
          await f.restart()
          const rows = await f.service().readRecords()
          expect(rows.some((row) => row.kind === 'cursor' && row.position === '0001')).toBe(
            outcome === 'commit',
          )
          for (const kind of ['notice', 'evidence', 'notice-event'] as const)
            expect(rows.filter((row) => row.kind === kind)).toHaveLength(
              outcome === 'commit' ? 1 : 0,
            )
          if (outcome === 'rollback') {
            restarted = create(f.service(), 12000)
            await restarted.start()
            expect(await f.service().forkNotices(f.key.groupID)).toHaveLength(1)
            expect(
              (await f.service().readRecords()).find((row) => row.kind === 'cursor'),
            ).toMatchObject({ position: '0001' })
          }
        } finally {
          if (!resolved && fault !== undefined) await fault.finish('rollback')
          await starting
          await worker.dispose()
          await restarted?.dispose()
          await f.close()
        }
      },
    )
  }
}
