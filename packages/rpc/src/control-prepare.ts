import { normalizeDID } from '@kokuin/token'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import type { AnchorSlot } from './anchor.js'
import { RETAINED_EPOCHS_MAX } from './app-frame.js'
import type { BufferedControlPage } from './buffered-control.js'
import { classifyCommit, digestAppliedCommit } from './classify.js'
import { decodeCommitFrame } from './commit-frame.js'
import { appliedRows } from './control/forks.js'
import { controlSafetyHeld } from './control/safety.js'
import { consumeOwnOccurrence } from './control/slot.js'
import { pruneWindow } from './control/store.js'
import type { AdoptionWriteFactory, ControlSnapshot, ControlStore } from './control/types.js'
import type { ReadyControlScope } from './control-batch.js'
import { isMissingLedgerEntries } from './crypto.js'
import { asLogPosition } from './cursor.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND, HANDSHAKE_VERSION } from './handshake.js'
import {
  createLedgerEntryResolver,
  DeliveredEntryCopyError,
  LedgerEntryRefusedError,
  UnsupportedLedgerEntriesVersionError,
} from './ledger-entries.js'
import type { StrandObservation } from './peer-types.js'
import { detectLeafAdmission, detectRosterChange } from './roster.js'
import { APP_TOPIC_LABEL } from './topic.js'

type AdoptionInput = {
  snapshot: ControlSnapshot
  epoch: number
  digest: string
  payloadDigest: string
  position: ReturnType<typeof asLogPosition>
  external: boolean
}

export type PreparedControlOccurrence = {
  consumed: boolean
  advanced: boolean
  prerequisite?: 'ledger' | 'recovery'
  removed?: boolean
  diagnostic?: Omit<StrandObservation, 'groupID'>
}

export async function prepareControlOccurrence(params: {
  scope: ReadyControlScope
  page: BufferedControlPage
  index: number
  localDID: string
  ownCommitDigest(commit: Uint8Array): string | null
  adoption(input: AdoptionInput): AdoptionWriteFactory
  newID(): string
}): Promise<PreparedControlOccurrence> {
  const { scope, page, index, newID } = params
  const message = page.result.messages[index]
  if (message === undefined) return { consumed: false, advanced: false }
  const initial = scope.control()
  if (
    controlSafetyHeld(initial) !== null ||
    initial.controlHold !== null ||
    initial.strand !== null ||
    initial.cursor?.stranded === true ||
    initial.rejoin !== null ||
    initial.forkRecoveryAttempt != null
  )
    return { consumed: false, advanced: false, prerequisite: 'recovery' }
  if (!(await scope.isLedgerComplete()))
    return { consumed: false, advanced: false, prerequisite: 'ledger' }
  const epoch = await scope.readEpoch()
  const position = asLogPosition(message.sequenceID)
  if (initial.cursor?.position != null && position <= initial.cursor.position)
    return { consumed: true, advanced: false }
  let incomplete = initial.cursor?.incomplete === true || page.result.gap
  if (page.result.gap && initial.cursor?.incomplete !== true)
    scope.stageControl(
      {
        cursor: {
          ...(initial.cursor ?? { position: null, epoch }),
          incomplete: true,
        },
      },
      newID(),
    )
  let diagnostic: PreparedControlOccurrence['diagnostic'] = page.result.gap
    ? {
        position,
        commitDigest: null,
        localEpoch: epoch,
        claimedEpoch: null,
        kind: 'retention-gap',
        confidence: 'claimed',
      }
    : undefined
  const skip = (occurrenceEpoch?: number, retryForbidden = false): PreparedControlOccurrence => {
    const snapshot = scope.control()
    const slot = snapshot.commitOnce
    scope.stageControl(
      {
        ...pruneWindow(snapshot, Math.max(epoch, ...snapshot.applied.map((row) => row.epoch))),
        ...(slot !== null &&
        (incomplete || occurrenceEpoch === undefined || occurrenceEpoch === slot.epoch) &&
        (slot.head === null || position > slot.head)
          ? {
              commitOnce: {
                ...slot,
                skipped: true,
                retryForbidden: retryForbidden || (slot.retryForbidden ?? slot.skipped === true),
              },
            }
          : {}),
        cursor: { position, epoch, ...(incomplete ? { incomplete: true } : {}) },
      },
      newID(),
    )
    return { consumed: true, advanced: false, ...(diagnostic === undefined ? {} : { diagnostic }) }
  }
  let commitFrame: ReturnType<typeof decodeCommitFrame>
  try {
    const frame = decodeHandshakeFrame(message.payload)
    if (frame.version !== HANDSHAKE_VERSION) {
      diagnostic = {
        position,
        commitDigest: null,
        localEpoch: epoch,
        claimedEpoch: null,
        kind: 'unknown-version',
        confidence: 'claimed',
      }
      return skip()
    }
    if (frame.kind !== HANDSHAKE_KIND.commit) return skip()
    commitFrame = decodeCommitFrame(frame.payload)
  } catch {
    return skip()
  }
  let header: Awaited<ReturnType<ReadyControlScope['readCommitHeader']>>
  try {
    header = await scope.readCommitHeader(commitFrame.commit)
  } catch (error) {
    if (error instanceof Error && error.name === 'CommitValidationUnavailableError')
      return { consumed: false, advanced: false, prerequisite: 'recovery' }
    throw error
  }
  if (header?.committerDID !== undefined)
    header = { ...header, committerDID: normalizeDID(header.committerDID) }
  const digest = digestAppliedCommit(commitFrame.commit)
  const disposition = classifyCommit({
    header,
    sequenceID: position,
    commitDigest: digest,
    state: { localDID: params.localDID, epoch, appliedByEpoch: appliedRows(initial) },
  })
  if (disposition.row === 'ahead') incomplete = true
  if (
    disposition.row === 'ahead' ||
    disposition.row === 'past-epoch-divergence' ||
    disposition.row === 'fork'
  )
    diagnostic = {
      position,
      commitDigest: digest,
      localEpoch: epoch,
      claimedEpoch: header?.epoch ?? null,
      kind: disposition.row === 'ahead' ? 'ahead' : 'past-epoch-divergence',
      confidence: 'claimed',
    }
  if (disposition.row !== 'apply' && disposition.row !== 'own-unmerged') return skip(header?.epoch)
  let originalAnchor = scope.anchor()
  if (originalAnchor?.pending?.landed && originalAnchor.pending.epochAfter !== epoch)
    return { consumed: false, advanced: false, prerequisite: 'recovery' }
  const before = await scope.rosterEntries()
  const admissions = (entries: typeof before) =>
    entries.flatMap((entry) => (entry.admission === undefined ? [] : [entry.admission]))
  const resolveAnchor = async (slot: AnchorSlot, rotate: boolean): Promise<AnchorSlot> => {
    if (!rotate)
      return {
        anchor: slot.anchor,
        ...(slot.departing === undefined ? {} : { departing: slot.departing }),
      }
    const captured = await scope.exportSecret(APP_TOPIC_LABEL)
    const departing = [
      ...(slot.departing ?? []),
      { anchor: slot.anchor, departedAt: captured.epoch },
    ].slice(-RETAINED_EPOCHS_MAX)
    return {
      anchor: { secret: captured.secret, epoch: captured.epoch },
      ...(departing.length === 0 ? {} : { departing }),
    }
  }
  if (originalAnchor?.pending !== undefined) {
    const pending = originalAnchor.pending
    const changed =
      pending.landed === true &&
      (pending.forced ||
        detectRosterChange(
          pending.rosterBefore,
          before.map((entry) => normalizeDID(entry.did)),
        ) ||
        (pending.admissionsBefore !== undefined &&
          detectLeafAdmission(pending.admissionsBefore, admissions(before))))
    originalAnchor = await resolveAnchor(originalAnchor, changed)
  }
  if (originalAnchor !== null)
    scope.stageAnchor({
      ...originalAnchor,
      pending: {
        epochBefore: epoch,
        epochAfter: epoch + 1,
        rosterBefore: before.map((entry) => normalizeDID(entry.did)),
        admissionsBefore: admissions(before),
        forced: header?.external === true,
        advance: digest,
      },
    })
  const control: ControlStore = {
    key: scope.source.key,
    load: async () => scope.control(),
    lastMutation: async () => null,
    apply: async (changes, mutationID) => scope.stageControl(changes, mutationID),
  }
  if (disposition.row === 'own-unmerged') {
    const slot = initial.commitOnce
    if (slot === null) {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return skip(header?.epoch)
    }
    let recognised = slot.payloadDigest === toB64U(sha256(message.payload))
    if (!recognised) {
      try {
        const saved = decodeCommitFrame(decodeHandshakeFrame(slot.payload).payload).commit
        const own = params.ownCommitDigest(saved)
        recognised = own !== null && own === params.ownCommitDigest(commitFrame.commit)
      } catch {
        recognised = false
      }
    }
    if (!recognised) {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return skip(header?.epoch)
    }
    const result = await consumeOwnOccurrence(
      {
        control,
        validation: scope.validation,
        adoption: { adopt: scope.prepareOwn },
        now: Date.now,
        newID,
        emit: () => {},
      },
      { position, payload: message.payload, senderDID: message.senderDID },
    )
    if (result === 'unavailable' || result === 'moved') {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return { consumed: false, advanced: false, prerequisite: 'recovery' }
    }
    if (result !== 'installed' && result !== 'noop') {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return skip(header?.epoch)
    }
  } else {
    const snapshot = scope.control()
    // Keep incomplete saved work for authenticated recovery inspection.
    if (snapshot.commitOnce !== null && snapshot.cursor?.incomplete === true) {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return {
        consumed: false,
        advanced: false,
        prerequisite: 'recovery',
        ...(diagnostic === undefined ? {} : { diagnostic }),
      }
    }
    const adoption = params.adoption({
      snapshot,
      epoch,
      digest,
      payloadDigest: toB64U(sha256(message.payload)),
      position,
      external: header?.external === true,
    })
    let result: Awaited<ReturnType<ReadyControlScope['prepareCommit']>>
    try {
      result = await scope.prepareCommit(commitFrame.commit, {
        senderDID: message.senderDID,
        adoption: (staged) => {
          const write = adoption(staged)
          if (
            page.result.gap &&
            write.changes.cursor !== undefined &&
            write.changes.cursor !== null
          )
            write.changes.cursor = { ...write.changes.cursor, incomplete: true }
          return write
        },
        resolveLedgerEntries: createLedgerEntryResolver(
          commitFrame.sealedEntries,
          scope.openEntries,
        ),
      })
    } catch (error) {
      if (
        error instanceof DeliveredEntryCopyError ||
        error instanceof UnsupportedLedgerEntriesVersionError ||
        error instanceof LedgerEntryRefusedError ||
        isMissingLedgerEntries(error)
      ) {
        if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
        return skip(header?.epoch)
      }
      throw error
    }
    if (result.validation === 'unavailable') {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return { consumed: false, advanced: false, prerequisite: 'recovery' }
    }
    if (!result.applied) {
      if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
      return skip(header?.epoch, true)
    }
  }
  const afterEpoch = await scope.readEpoch()
  const removed = scope.control().applied.some((row) => row.epoch === epoch && row.removed)
  if (!removed) {
    const after = await scope.rosterEntries()
    const pending = originalAnchor?.pending
    const rosterBefore = pending?.landed
      ? pending.rosterBefore
      : before.map((entry) => normalizeDID(entry.did))
    const admissionsBefore = pending?.landed ? pending.admissionsBefore : admissions(before)
    const rotate =
      header?.external === true ||
      pending?.forced === true ||
      detectRosterChange(
        rosterBefore,
        after.map((entry) => normalizeDID(entry.did)),
      ) ||
      (admissionsBefore !== undefined && detectLeafAdmission(admissionsBefore, admissions(after)))
    if (rotate || originalAnchor === null) {
      const captured = await scope.exportSecret(APP_TOPIC_LABEL)
      const departing =
        originalAnchor === null
          ? []
          : [
              ...(originalAnchor.departing ?? []),
              { anchor: originalAnchor.anchor, departedAt: captured.epoch },
            ].slice(-RETAINED_EPOCHS_MAX)
      scope.stageAnchor({
        anchor: { secret: captured.secret, epoch: captured.epoch },
        ...(departing.length === 0 ? {} : { departing }),
      })
    } else
      scope.stageAnchor({
        anchor: originalAnchor.anchor,
        ...(originalAnchor.departing === undefined ? {} : { departing: originalAnchor.departing }),
      })
  } else if (originalAnchor !== null) scope.stageAnchor(originalAnchor)
  return {
    consumed: true,
    advanced: afterEpoch !== epoch,
    removed,
    ...(diagnostic === undefined ? {} : { diagnostic }),
  }
}
