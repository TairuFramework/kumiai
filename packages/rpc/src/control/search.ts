import type { HubFetchTopicResult } from '@kumiai/hub-tunnel'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { digestAppliedCommit } from '../classify.js'
import { decodeCommitFrame, isUnsupportedCommitFrameVersion } from '../commit-frame.js'
import type { CommitHeader } from '../crypto.js'
import { asLogPosition, type LogPosition } from '../cursor.js'
import { decodeHandshakeFrame, HANDSHAKE_KIND, HANDSHAKE_VERSION } from '../handshake.js'
import type { GroupForkEvidence, SafetyHold } from './safety.js'
import type {
  AdoptionExpected,
  AppliedCommit,
  BuiltCommit,
  CommitCursor,
  ControlSearchPort,
  EpochIdentity,
  GroupKey,
} from './types.js'

export type ControlLogFrame = { position: LogPosition; payload: Uint8Array; senderDID: string }
export type ControlFrameValidation =
  | { kind: 'valid'; header: CommitHeader; own: boolean; advanced: boolean; removed: boolean }
  | { kind: 'invalid'; reason: 'non-commit' | 'malformed' | 'authentication' | 'policy' }
  | {
      kind: 'unavailable'
      reason:
        | 'unsupported-version'
        | 'missing-proposal'
        | 'missing-key'
        | 'resolver'
        | 'unrecognised'
        | 'unexplained-own'
    }
export type ControlValidation = {
  source: AdoptionExpected
  readCommitHeader(commit: Uint8Array): Promise<CommitHeader | null>
  validateFrame(
    frame: ControlLogFrame,
    built: BuiltCommit,
    header?: CommitHeader | null,
  ): Promise<ControlFrameValidation>
  verifyOwn(built: BuiltCommit): Promise<boolean>
}
export type ControlValidationPort = {
  restoreValidation(built: BuiltCommit): Promise<ControlValidation | null>
}
export type ControlEvidenceSnapshot = {
  source: AdoptionExpected
  applied: Array<AppliedCommit>
  cursor: CommitCursor | null
  terminal: boolean
}
export type { GroupForkEvidence } from './safety.js'
export type CertifiedControlRange = {
  key: GroupKey
  source: EpochIdentity
  from: LogPosition | null
  through: LogPosition
  winner: { position: LogPosition; payloadDigest: string }
  losers: Array<{ position: LogPosition; payloadDigest: string }>
}
export type FollowWinnerResult =
  | { kind: 'applied'; position: LogPosition }
  | { kind: 'unavailable' | 'refused' | 'moved' }
export type ControlHold = {
  reason: 'acceptance-unknown' | 'unsupported-version'
  position: LogPosition | null
}
export type ControlSearchBudget = { maxPasses: number; maxFetches: number; maxFrames: number }
export type ControlSearchWork = { takeFetch(): boolean; takeFrame(): boolean }
export type ControlSearchDeps = {
  budget: ControlSearchBudget
  fetch(after: LogPosition | null): Promise<HubFetchTopicResult>
  validation: ControlValidationPort
  readEvidence(): Promise<ControlEvidenceSnapshot>
  followWinner(
    frame: ControlLogFrame,
    range: CertifiedControlRange,
    work: ControlSearchWork,
  ): Promise<FollowWinnerResult>
  reconcileAbsent(
    head: LogPosition | null,
    range: CertifiedControlRange | null,
    work: ControlSearchWork,
  ): Promise<boolean>
  hold(value: ControlHold): Promise<void>
  haltFork(evidence: GroupForkEvidence): Promise<void>
  safetyHold(): SafetyHold
}

export const CONTROL_SEARCH_BUDGET: ControlSearchBudget = {
  maxPasses: 2,
  maxFetches: 16,
  maxFrames: 256,
}

function sameKey(left: GroupKey, right: GroupKey): boolean {
  return left.groupID === right.groupID && left.incarnation === right.incarnation
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}
function sameIdentity(left: EpochIdentity | null, right: EpochIdentity | null): boolean {
  return (
    left !== null &&
    right !== null &&
    sameKey(left, right) &&
    left.epoch === right.epoch &&
    sameBytes(left.authenticator, right.authenticator)
  )
}

export function isCertifiedControlLoser(
  range: CertifiedControlRange,
  key: GroupKey,
  epoch: number,
  position: LogPosition,
  payloadDigest: string,
): boolean {
  return (
    sameKey(range.key, key) &&
    sameKey(range.source, key) &&
    range.source.epoch === epoch &&
    (range.from === null || position > range.from) &&
    position <= range.through &&
    range.losers.some((row) => row.position === position && row.payloadDigest === payloadDigest)
  )
}

type Discovery = {
  built: BuiltCommit
  source: AdoptionExpected
  through: LogPosition | null
  head: LogPosition | null
  latestHead: LogPosition | null
  captured: boolean
  complete: boolean
  winner: ControlLogFrame | null
  losers: CertifiedControlRange['losers']
  occurrence: LogPosition | null
}

function sameBuild(left: BuiltCommit, right: BuiltCommit): boolean {
  return (
    left.incarnation === right.incarnation &&
    left.epoch === right.epoch &&
    left.searchFrom === right.searchFrom &&
    left.publishID === right.publishID &&
    left.payloadDigest === right.payloadDigest &&
    left.digest === right.digest &&
    sameBytes(left.authenticatorBefore, right.authenticatorBefore) &&
    sameBytes(left.journal, right.journal) &&
    sameBytes(left.payload, right.payload)
  )
}

function checkedPage(
  page: HubFetchTopicResult,
  after: LogPosition | null,
  previousHead: LogPosition | null,
): boolean {
  if (page.gap !== false) return false
  if (page.head === null)
    return after === null && previousHead === null && page.messages.length === 0
  if ((after !== null && page.head < after) || (previousHead !== null && page.head < previousHead))
    return false
  let previous: string | null = after
  for (const row of page.messages) {
    if ((previous !== null && row.sequenceID <= previous) || row.sequenceID > page.head)
      return false
    previous = row.sequenceID
  }
  return page.messages.length !== 0 || page.head === after
}

export function createControlSearch(deps: ControlSearchDeps): ControlSearchPort {
  for (const limit of Object.values(deps.budget)) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new RangeError('Control search budgets must be positive integers')
  }
  // The owning peer lane must await each searchLog call before starting another.
  let continuation: Discovery | null = null
  return {
    async searchLog(built) {
      let fetches = 0
      let frames = 0
      const held = () => deps.safetyHold() !== null
      const stopped = () => {
        continuation = null
        return { kind: 'unknown' as const }
      }
      const holdFork = async (value: GroupForkEvidence) => {
        await deps.haltFork(value)
      }
      const work: ControlSearchWork = {
        takeFetch: () => fetches < deps.budget.maxFetches && ++fetches > 0,
        takeFrame: () => frames < deps.budget.maxFrames && ++frames > 0,
      }
      const unknown = async (
        position: LogPosition | null = null,
        reason: ControlHold['reason'] = 'acceptance-unknown',
      ) => {
        if (!held()) await deps.hold({ reason, position })
        return { kind: 'unknown' as const }
      }
      if (held()) return stopped()
      const forkUnknown = async (value: GroupForkEvidence) => {
        await holdFork(value)
        return stopped()
      }
      const validation = await deps.validation.restoreValidation(built)
      if (held()) return stopped()
      const retained = validation?.source.identity
      if (
        validation === null ||
        retained == null ||
        retained.epoch !== built.epoch ||
        retained.incarnation !== built.incarnation ||
        !sameKey(validation.source.key, retained) ||
        !sameBytes(retained.authenticator, built.authenticatorBefore) ||
        toB64U(sha256(built.payload)) !== built.payloadDigest
      ) {
        continuation = null
        return unknown()
      }
      let evidence = await deps.readEvidence()
      if (held()) return stopped()
      if (evidence.cursor?.stranded === true) {
        continuation = null
        return unknown(evidence.cursor.position)
      }
      const coherent = async (): Promise<boolean> => {
        const current = evidence.source.identity
        if (
          !sameKey(evidence.source.key, validation.source.key) ||
          current === null ||
          !sameKey(current, retained) ||
          current.epoch < retained.epoch
        )
          return false
        if (
          current.epoch === retained.epoch &&
          !sameBytes(current.authenticator, retained.authenticator)
        ) {
          await holdFork({
            kind: 'epoch-authenticator',
            epoch: retained.epoch,
            local: retained.authenticator.slice(),
            remote: current.authenticator.slice(),
          })
          return false
        }
        return true
      }
      if (!(await coherent())) {
        continuation = null
        return unknown()
      }
      const applied = () => evidence.applied.find((row) => row.epoch === retained.epoch)
      if (
        ((evidence.source.identity?.epoch ?? retained.epoch) > retained.epoch ||
          evidence.terminal) &&
        applied() === undefined
      ) {
        continuation = null
        return unknown()
      }
      if (
        continuation !== null &&
        (!sameBuild(continuation.built, built) ||
          !sameIdentity(continuation.source.identity, retained) ||
          !sameKey(continuation.source.key, validation.source.key))
      )
        continuation = null
      const discovery: Discovery = continuation ?? {
        built: {
          ...built,
          journal: built.journal.slice(),
          payload: built.payload.slice(),
          authenticatorBefore: built.authenticatorBefore.slice(),
        },
        source: validation.source,
        through: built.searchFrom,
        head: null,
        latestHead: null,
        captured: false,
        complete: false,
        winner: null,
        losers: [],
        occurrence: null,
      }
      continuation = discovery
      const range = (): CertifiedControlRange | null =>
        discovery.winner === null || discovery.through === null
          ? null
          : {
              key: { ...validation.source.key },
              source: { ...retained, authenticator: retained.authenticator.slice() },
              from: built.searchFrom,
              through: discovery.through,
              winner: {
                position: discovery.winner.position,
                payloadDigest: toB64U(sha256(discovery.winner.payload)),
              },
              losers: discovery.losers.map((row) => ({ ...row })),
            }
      const committedWinner = async (): Promise<boolean> => {
        if (held()) return false
        evidence = await deps.readEvidence()
        if (held()) return false
        if (!(await coherent())) {
          continuation = null
          return false
        }
        const row = applied()
        if (row === undefined)
          return evidence.source.identity?.epoch === retained.epoch && !evidence.terminal
        const winner = discovery.winner
        if (winner === null) {
          continuation = null
          return false
        }
        const winnerDigest = digestAppliedCommit(
          decodeCommitFrame(decodeHandshakeFrame(winner.payload).payload).commit,
        )
        const winnerPayloadDigest = toB64U(sha256(winner.payload))
        if (
          row.sequenceID !== winner.position ||
          row.payloadDigest !== winnerPayloadDigest ||
          row.digest !== winnerDigest
        ) {
          continuation = null
          await holdFork({
            kind: 'digest-divergence',
            epoch: retained.epoch,
            position: winner.position,
            localDigest: row.payloadDigest === winnerPayloadDigest ? row.digest : row.payloadDigest,
            remoteDigest:
              row.payloadDigest === winnerPayloadDigest ? winnerDigest : winnerPayloadDigest,
          })
          return false
        }
        return true
      }
      const follow = async (): Promise<boolean> => {
        if (held()) return false
        const certificate = range()
        if (certificate === null || discovery.winner === null) return true
        if (!(await committedWinner()) || held()) return false
        const followed = await deps.followWinner(discovery.winner, certificate, work)
        if (held()) return false
        return followed.kind === 'applied' && followed.position === discovery.winner.position
      }
      const settleOccurrence = async () => {
        if (held()) return stopped()
        if (discovery.winner === null || discovery.occurrence === null)
          return unknown(discovery.through)
        if (toB64U(sha256(discovery.winner.payload)) === built.payloadDigest) {
          if (!(await validation.verifyOwn(built)) || !(await committedWinner()))
            return unknown(discovery.winner.position)
          if (held()) return stopped()
          continuation = null
          const proofSource = sameIdentity(evidence.source.identity, retained)
            ? evidence.source
            : validation.source
          return {
            kind: 'first-valid' as const,
            proof: {
              source: proofSource,
              from: built.searchFrom,
              position: discovery.occurrence,
              payloadDigest: built.payloadDigest,
            },
          }
        }
        if (!(await follow())) return unknown(discovery.winner.position)
        if (held()) return stopped()
        continuation = null
        return { kind: 'superseded' as const, winner: discovery.winner.position }
      }
      if (discovery.winner !== null && applied() !== undefined && !(await committedWinner()))
        return unknown(discovery.winner.position)
      if (discovery.occurrence !== null) return settleOccurrence()
      for (let pass = 0; pass < deps.budget.maxPasses; pass++) {
        while (!discovery.complete) {
          if (held()) return stopped()
          if (!work.takeFetch()) return unknown(discovery.through)
          const page = await deps.fetch(discovery.through)
          if (held()) return stopped()
          if (!checkedPage(page, discovery.through, discovery.latestHead)) {
            continuation = null
            return unknown(discovery.through)
          }
          discovery.latestHead = page.head === null ? null : asLogPosition(page.head)
          if (!discovery.captured) {
            discovery.head = discovery.latestHead
            discovery.captured = true
          }
          for (const row of page.messages) {
            if (held()) return stopped()
            const position = asLogPosition(row.sequenceID)
            if (discovery.head !== null && position > discovery.head) break
            if (!work.takeFrame()) return unknown(discovery.through)
            const frame: ControlLogFrame = {
              position,
              payload: row.payload.slice(),
              senderDID: row.senderDID,
            }
            let commit: Uint8Array
            try {
              const handshake = decodeHandshakeFrame(frame.payload)
              if (handshake.version !== HANDSHAKE_VERSION) {
                continuation = null
                return unknown(position, 'unsupported-version')
              }
              if (handshake.kind !== HANDSHAKE_KIND.commit) {
                discovery.through = position
                continue
              }
              commit = decodeCommitFrame(handshake.payload).commit
            } catch (error) {
              if (isUnsupportedCommitFrameVersion(error)) {
                continuation = null
                return unknown(position, 'unsupported-version')
              }
              discovery.through = position
              continue
            }
            let header: CommitHeader | null
            try {
              header = await validation.readCommitHeader(commit)
              if (held()) return stopped()
            } catch {
              continuation = null
              return unknown(position)
            }
            if (header === null) {
              discovery.through = position
              continue
            }
            if (header.epoch < retained.epoch) {
              const historic = evidence.applied.find((entry) => entry.epoch === header.epoch)
              if (historic === undefined) {
                continuation = null
                return unknown(position)
              }
              discovery.through = position
              continue
            }
            if (header.epoch > retained.epoch) {
              if (discovery.winner === null) {
                continuation = null
                await deps.reconcileAbsent(position, null, work)
                return unknown(position)
              }
              discovery.through = position
              continue
            }
            if (held()) return stopped()
            const result = await validation.validateFrame(frame, built, header)
            if (held()) return stopped()
            if (result.kind === 'unavailable') {
              continuation = null
              if (result.reason === 'unexplained-own')
                return await forkUnknown({
                  kind: 'unexplained-own-commit',
                  epoch: retained.epoch,
                  position,
                  digest: digestAppliedCommit(commit),
                })
              return unknown(
                position,
                result.reason === 'unsupported-version'
                  ? 'unsupported-version'
                  : 'acceptance-unknown',
              )
            }
            discovery.through = position
            if (result.kind === 'invalid') continue
            const fullDigest = toB64U(sha256(frame.payload))
            if (discovery.winner === null) discovery.winner = frame
            else discovery.losers.push({ position, payloadDigest: fullDigest })
            if (result.own && fullDigest !== built.payloadDigest) {
              continuation = null
              return await forkUnknown({
                kind: 'unexplained-own-commit',
                epoch: retained.epoch,
                position,
                digest: digestAppliedCommit(commit),
              })
            }
            if (fullDigest === built.payloadDigest && result.own) {
              discovery.occurrence = position
              return settleOccurrence()
            }
          }
          discovery.complete = discovery.head === null || discovery.through === discovery.head
        }
        if (discovery.winner !== null && !(await follow()))
          return unknown(discovery.winner.position)
        if (!(await deps.reconcileAbsent(discovery.head, range(), work)))
          return unknown(discovery.through)
        if (held()) return stopped()
        if (!work.takeFetch()) return unknown(discovery.through)
        const probe = await deps.fetch(discovery.through)
        if (held()) return stopped()
        if (!checkedPage(probe, discovery.through, discovery.latestHead)) {
          continuation = null
          return unknown(discovery.through)
        }
        const nextHead = probe.head === null ? null : asLogPosition(probe.head)
        if (nextHead === discovery.head) {
          if (!(await committedWinner())) return unknown(discovery.through)
          continuation = null
          if (held()) return stopped()
          return { kind: 'absent' }
        }
        discovery.head = nextHead
        discovery.latestHead = nextHead
        discovery.complete = false
      }
      return unknown(discovery.through)
    },
  }
}
