import { describe, expect, test } from 'vitest'

import type { ConformanceControlSlot } from './control-store.js'

export type CommitOnceScenario =
  | 'alternate-id-replay'
  | 'public-member-winner'
  | 'gap-match'
  | 'trimmed-checkpoint'
  | 'validation-unavailable'
  | 'poison-head'
  | 'built-restart'
  | 'accepted-restart'
  | 'late-acked-slot'
  | 'epoch-move'
  | 'deadline'
  | 'progress'
  | 'slot-guards'
  | 'terminal-winner'
  | 'ownership-conflict'

export type CommitOnceEvidence = {
  outcome: 'landed' | 'lost' | 'unknown'
  builds: number
  ownAdoptions: number
  welcomeDeliveries: number
  payloads: Array<Uint8Array>
  publishIDs: Array<string>
  expectedHeads: Array<string | null>
  searchFrom: string | null
  slotAfterAck: ConformanceControlSlot | null
  winnerFollowed: boolean
  candidateMatchesReceiver: boolean
  progressPreserved: boolean
  cursor: string | null
  terminal: boolean
  publicationsBeforeProof: number
}

const scenarios: Array<[CommitOnceScenario, string]> = [
  ['alternate-id-replay', 'earlier valid competitor supersedes an alternate-ID exact own replay'],
  [
    'public-member-winner',
    'earlier public member winner supersedes an alternate-ID exact own replay',
  ],
  ['gap-match', 'match never bypasses suffix or page gaps'],
  ['trimmed-checkpoint', 'trimmed checkpoint cannot prove first-valid acceptance'],
  ['validation-unavailable', 'unavailable header or body resolution cannot hide an earlier winner'],
  ['poison-head', 'poison prefix retries the identical commit and real receiver matches candidate'],
  ['built-restart', 'restart after built-save or head refresh keeps one exact build'],
  ['accepted-restart', 'accepted restart rechecks checkpoint suffix before adoption or Welcome'],
  [
    'late-acked-slot',
    'late first-valid landing of an acked unknown slot adopts and owes its Welcome',
  ],
  ['epoch-move', 'epoch advance rebuilds only after complete absence and intent revalidation'],
  ['deadline', 'deadline survives reconstruction with changed configuration'],
  ['progress', 'ordinary adoption preserves committed sender and receiver progress'],
  ['slot-guards', 'rejection abandon and generic deletion retain the slot'],
  [
    'terminal-winner',
    'first-valid removal follows the winner without installing the own candidate',
  ],
  [
    'ownership-conflict',
    'control transition proof conflict fail-stops before publication Welcome or hooks',
  ],
]

export function testCommitOnceConformance(params: {
  label: string
  run(scenario: CommitOnceScenario): Promise<CommitOnceEvidence>
}): void {
  describe(`commit-once conformance: ${params.label}`, () => {
    for (const [scenario, name] of scenarios) {
      test(name, async () => {
        const evidence = await params.run(scenario)
        expect(evidence.publicationsBeforeProof).toBe(0)
        expect(evidence.builds).toBeGreaterThan(0)
        expect(evidence.payloads).toHaveLength(evidence.publishIDs.length)
        expect(evidence.expectedHeads).toHaveLength(evidence.publishIDs.length)
        switch (scenario) {
          case 'alternate-id-replay':
          case 'public-member-winner':
          case 'terminal-winner':
            expect(evidence.outcome).toBe('lost')
            expect(evidence.winnerFollowed).toBe(true)
            expect(evidence.ownAdoptions).toBe(0)
            expect(evidence.welcomeDeliveries).toBe(0)
            expect(evidence.cursor).not.toBeNull()
            expect(evidence.terminal).toBe(scenario === 'terminal-winner')
            break
          case 'gap-match':
          case 'trimmed-checkpoint':
          case 'validation-unavailable':
          case 'accepted-restart':
            expect(evidence.outcome).toBe('unknown')
            expect(evidence.builds).toBe(1)
            expect(evidence.ownAdoptions).toBe(0)
            expect(evidence.welcomeDeliveries).toBe(0)
            expect(evidence.slotAfterAck).not.toBeNull()
            break
          case 'deadline':
          case 'slot-guards':
            expect(evidence.outcome).toBe('lost')
            expect(evidence.builds).toBe(1)
            expect(evidence.ownAdoptions).toBe(0)
            expect(evidence.welcomeDeliveries).toBe(0)
            expect(evidence.slotAfterAck).not.toBeNull()
            expect(evidence.payloads).toEqual([])
            break
          case 'ownership-conflict':
            expect(evidence.ownAdoptions).toBe(0)
            expect(evidence.welcomeDeliveries).toBe(0)
            expect(evidence.payloads).toEqual([])
            break
          default:
            expect(evidence.outcome).toBe('landed')
            expect(evidence.builds).toBe(scenario === 'epoch-move' ? 2 : 1)
            expect(evidence.ownAdoptions).toBe(1)
            expect(evidence.welcomeDeliveries).toBe(1)
            expect(evidence.slotAfterAck).toBeNull()
            expect(evidence.cursor).not.toBeNull()
            expect(evidence.candidateMatchesReceiver).toBe(true)
            if (scenario === 'progress') expect(evidence.progressPreserved).toBe(true)
            if (scenario === 'poison-head' || scenario === 'built-restart') {
              expect(evidence.payloads.length).toBeGreaterThanOrEqual(2)
              expect(evidence.payloads[1]).toEqual(evidence.payloads[0])
              expect(evidence.publishIDs[1]).toBe(evidence.publishIDs[0])
              expect(evidence.expectedHeads[1]).not.toBe(evidence.expectedHeads[0])
              expect(evidence.searchFrom).not.toBe(evidence.expectedHeads[1])
            }
        }
      })
    }
  })
}
