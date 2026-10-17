import type { GroupHandle } from '@kumiai/mls'
import { decodeClientState, restrictCommitAuthoring } from '@kumiai/mls'
import type { ControlAdoptionPort, ControlStore } from '@kumiai/rpc'
import { controlSafetyHeld } from '@kumiai/rpc'

import type { ControlHandleAccess } from './access.js'
import { controlCompatible } from './control-compat.js'
import { decodeControlJournal } from './control-journal.js'
import { sameStoredValue } from './memory-incarnation-stores.js'

export function createControlAdoptionPort(params: {
  access: ControlHandleAccess
  control: ControlStore
  restoreCandidate: (candidate: Uint8Array) => Promise<GroupHandle>
}): ControlAdoptionPort {
  return {
    async adopt(bytes, expected, write) {
      const held = await params.access.readControl(async (scope) =>
        controlSafetyHeld(await scope.loadControl(params.control)),
      )
      if (held !== null) return 'moved'
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
      const candidate = restrictCommitAuthoring(await params.restoreCandidate(journal.candidate))
      if (
        candidate.groupID !== expected.key.groupID ||
        (journal.candidateAuthenticator !== undefined &&
          !sameStoredValue(
            candidate.state.keySchedule.epochAuthenticator,
            journal.candidateAuthenticator,
          ))
      )
        return 'moved'
      const captured = await params.access.readControl(async (scope) => ({
        source: scope.source,
        snapshot: await scope.loadControl(params.control),
      }))
      const lastMutation = await params.control.lastMutation()
      let result: 'installed' | 'noop' | 'moved' = 'moved'
      try {
        await params.access.replace(
          candidate,
          () => ({ ...write, expected: { ...expected, journal: bytes } }),
          async (current, source) => {
            const sourceState = decodeClientState(journal.sourceState)
            if (
              !sameStoredValue(source.key, expected.key) ||
              !sameStoredValue(source.identity, expected.identity) ||
              !sameStoredValue(source.key, captured.source.key) ||
              !sameStoredValue(source.identity, captured.source.identity)
            )
              return false
            const snapshot = captured.snapshot
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
                lastMutation === write.mutationID
              )
                result = 'noop'
              return false
            }
            if (
              sourceState === undefined ||
              !controlCompatible(sourceState, current.state, journal.referencedProposals)
            )
              return false
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
