import type { GroupHandle } from '@kumiai/mls'
import type { ControlAdoptionPort, ControlStore } from '@kumiai/rpc'
import { controlSafetyHeld } from '@kumiai/rpc'

import type { HandleAccess } from './access.js'
import { decodeControlJournal } from './control-journal.js'
import { sameStoredValue } from './memory-incarnation-stores.js'

export function createControlAdoptionPort(params: {
  access: HandleAccess
  control: ControlStore
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlAdoptionPort {
  return {
    async adopt(bytes, expected, write) {
      if (controlSafetyHeld(await params.control.load()) !== null) return 'moved'
      const journal = decodeControlJournal(bytes)
      const proof = expected.acceptance
      if (
        !sameStoredValue(expected.key, params.control.key) ||
        !sameStoredValue(journal.source.key, expected.key) ||
        !sameStoredValue(proof.source.key, expected.key) ||
        !sameStoredValue(proof.source.identity, journal.source.identity) ||
        proof.from !== journal.checkpoint
      )
        return 'moved'
      const candidate = await params.restoreCandidate(journal.candidate)
      if (controlSafetyHeld(await params.control.load()) !== null) return 'moved'
      if (candidate.groupID !== expected.key.groupID) return 'moved'
      let result: 'installed' | 'noop' | 'moved' = 'moved'
      try {
        await params.access.replace(
          candidate,
          () => ({ ...write, expected: { ...expected, journal: bytes } }),
          async (current, source) => {
            if (
              !sameStoredValue(source, {
                key: expected.key,
                identity: expected.identity,
                stateVersion: expected.stateVersion,
              })
            )
              return false
            const snapshot = await params.control.load()
            if (
              controlSafetyHeld(snapshot) !== null ||
              snapshot.strand !== null ||
              snapshot.cursor?.stranded === true ||
              (snapshot.controlHold !== null &&
                snapshot.controlHold.reason !== 'acceptance-unknown')
            )
              return false
            const installed =
              current.epoch === candidate.epoch &&
              sameStoredValue(
                current.state.keySchedule.epochAuthenticator,
                candidate.state.keySchedule.epochAuthenticator,
              )
            if (installed) {
              const row = snapshot.applied.find(
                (row) => row.epoch === journal.source.identity?.epoch,
              )
              if (
                (row?.payloadDigest === proof.payloadDigest && row.sequenceID === proof.position) ||
                (await params.control.lastMutation()) === write.mutationID
              )
                result = 'noop'
              return false
            }
            const slot = snapshot.commitOnce
            if (
              !sameStoredValue(source.identity, journal.source.identity) ||
              slot === null ||
              slot.payloadDigest !== proof.payloadDigest ||
              !sameStoredValue(slot.journal, bytes) ||
              slot.searchFrom !== proof.from ||
              !sameStoredValue(snapshot.commitOnceAcceptance, proof)
            )
              return false
            await current.carryReceiveProgress(candidate)
            result = 'installed'
            return true
          },
        )
      } catch (error) {
        if (
          error instanceof Error &&
          ['RevisionConflictError', 'ControlAdoptionMovedError'].includes(error.name)
        )
          return 'moved'
        throw error
      }
      return result
    },
  }
}
