import { encodeMultibase } from '@kokuin/token'
import type {
  ForkRecoveryFixture,
  RosterAbsenceFixture,
  RosterAbsenceScenario,
} from '@kumiai/rpc-conformance'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromUTF, toB64U, toUTF } from '@sozai/codec'

import { digestAppliedCommit } from '../../src/classify.js'
import { encodeCommitFrame } from '../../src/commit-frame.js'
import { asLogPosition, type LogPosition } from '../../src/cursor.js'
import { encodeHandshakeFrame, HANDSHAKE_KIND } from '../../src/handshake.js'
import type {
  CapturedPendingRecovery,
  CapturedRejoinRecord,
  ForkRecoveryAttempt,
  ForkRecoveryAuthorisation,
} from '../../src/recovery-types.js'
import type { MemoryGroupInfo } from './memory-group-mls.js'
import { createMemoryGroupMLS, encodeMemoryCommit } from './memory-group-mls.js'

export function memoryCapturedRecord(
  pending: CapturedPendingRecovery,
  request: Uint8Array,
  requestKey: Uint8Array,
  requestID: string,
): CapturedRejoinRecord {
  const payload = encodeHandshakeFrame(
    HANDSHAKE_KIND.commit,
    encodeCommitFrame(pending.commit, new Uint8Array()),
  )
  return {
    format: 2,
    id: requestID,
    publishID: requestID,
    stage: 'built',
    source: pending.source,
    target: pending.target,
    captureHead: pending.target.captureHead,
    searchFrom: pending.target.captureHead,
    expectedHead: pending.target.captureHead,
    trigger: 'automatic',
    authorisationID: null,
    switchMutationID: null,
    destinationKey: null,
    payload,
    payloadDigest: digestAppliedCommit(payload),
    digest: digestAppliedCommit(pending.commit),
    requestID,
    request,
    requestKey,
    candidate: pending.serialize(),
    epochAfter: pending.epoch,
    ledgerBefore: [],
  }
}

export async function createCapturedMemoryRecovery(
  target = { targetID: 'hub', topicID: 'commits' },
) {
  const trust = {
    groupID: 'memory-capture',
    ownerDID: 'alice',
    members: ['alice', 'bob'],
    controller: 'controller',
    signerControllers: { alice: 'controller', bob: 'controller' },
    revoked: [] as Array<string>,
  }
  const source = {
    key: { groupID: trust.groupID, incarnation: 1 },
    stateVersion: 1,
    identity: null,
    lifetimeRevision: 1,
    trust,
    trustDigest: toB64U(sha256(fromUTF(JSON.stringify(trust)))),
  }
  let accepted = 0
  let sourceError: Error | null = null
  const options = {
    groupID: trust.groupID,
    members: trust.members,
    binding: { id: 'controller', prefix: [], capability: 'captured-capability' },
  }
  const requester = createMemoryGroupMLS({
    ...options,
    localDID: 'alice',
    capturedRecovery: {
      target,
      readSource: async () => {
        if (sourceError !== null) throw sourceError
        return source
      },
      accept: async () => {
        accepted++
      },
    },
  })
  const responder = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  return {
    invalidateRetainedSigner(kind: 'missing' | 'wrong-controller' | 'revoked') {
      if (kind === 'missing') trust.members = trust.members.filter((did) => did !== 'bob')
      else if (kind === 'wrong-controller') trust.signerControllers.bob = 'foreign-controller'
      else trust.revoked.push('bob')
      source.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(trust))))
    },
    requester,
    responder,
    failSource: (error: Error) => {
      sourceError = error
    },
    async restartResponder() {
      const database = responder.database()
      const state = await database.loadState(trust.groupID)
      if (state === null) throw new Error('Missing responder state')
      const restarted = createMemoryGroupMLS({ ...options, localDID: 'bob', hostDB: database })
      restarted.restoreState(state)
      return restarted
    },
    record: memoryCapturedRecord,
    confirmationTag: (key: Uint8Array, requestID: string) =>
      encodeMultibase(hmac(sha256, key, fromUTF(requestID))),
    accepted: () => accepted,
  }
}

export async function createRosterAbsenceMemoryFixture(
  scenario: RosterAbsenceScenario = 'absent',
): Promise<RosterAbsenceFixture> {
  const groupID = `roster-double-${crypto.randomUUID()}`
  const trust = {
    groupID,
    ownerDID: 'alice',
    members: ['alice', 'bob'],
    revoked: [] as Array<string>,
  }
  const source = {
    key: { groupID, incarnation: 1 },
    stateVersion: 1,
    identity: null,
    lifetimeRevision: 1,
    trust,
    trustDigest: toB64U(sha256(fromUTF(JSON.stringify(trust)))),
  }
  const options = { groupID, members: ['alice', 'bob'], epoch: 1 }
  const requester = createMemoryGroupMLS({
    ...options,
    localDID: 'alice',
    capturedRecovery: {
      target: { targetID: 'hub', topicID: 'commits' },
      readSource: async () => source,
      accept: async () => {
        throw new Error('Verification cannot adopt')
      },
    },
  })
  const responderSource = { ...source, trust: { ...trust, ownerDID: 'bob' }, trustDigest: '' }
  responderSource.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(responderSource.trust))))
  const responder = createMemoryGroupMLS({
    ...options,
    localDID: 'bob',
    capturedRecovery: {
      target: { targetID: 'hub', topicID: 'commits' },
      readSource: async () => responderSource,
      accept: async () => {
        throw new Error('Unexpected adoption')
      },
    },
  })
  await requester.persistInitialState()
  await responder.persistInitialState()
  const saved = await requester.createRecoveryRequest('saved-rejoin')
  const captured = requester.capturedRecovery
  if (captured === undefined) throw new Error('Missing captured requester')
  const pending = await captured.applyRecovery(
    await responder.sealGroupInfo(saved.request, null),
    'saved-rejoin',
    saved.requestKey,
  )
  if (pending === null || 'renewalRequired' in pending) throw new Error('Missing saved rejoin')
  await requester
    .control()
    .apply(
      { putRejoin: memoryCapturedRecord(pending, saved.request, saved.requestKey, 'saved-rejoin') },
      'save-rejoin',
    )
  await responder.processCommit(
    encodeMemoryCommit(
      1,
      'alice',
      [],
      scenario === 'present' ? { external: true, branch: 'fresh-leaf' } : { removes: ['alice'] },
    ),
    {},
  )
  if (scenario === 'wrong-key' || scenario === 'expired' || scenario === 'imported') {
    const state = JSON.parse(toUTF(responder.serializeState())) as {
      rosterHistory: Array<{
        epoch: number
        members: Array<{ did: string; keyHash: string }>
        supersededAt: number | null
      }>
    }
    for (const fact of state.rosterHistory) {
      if (fact.epoch >= 2) continue
      if (scenario === 'wrong-key')
        for (const member of fact.members)
          if (member.did === 'alice') member.keyHash = toB64U(new Uint8Array(32))
      if (scenario === 'expired') fact.supersededAt = Date.now() - 604800001
    }
    if (scenario === 'imported')
      state.rosterHistory = state.rosterHistory.filter((fact) => fact.epoch >= 2)
    responder.restoreState(fromUTF(JSON.stringify(state)))
  }
  return {
    requester,
    responder,
    epoch: 2,
    requesterDID: 'alice',
    responderDID: 'bob',
    async refuseResponder(reason) {
      await responder.control().apply(
        reason === 'fork-halted'
          ? {
              forkHalt: {
                eventID: JSON.stringify(['group:fork', groupID, 1]),
                detectedAt: 1,
                evidence: {
                  kind: 'unexplained-own-commit',
                  epoch: 2,
                  position: 'head',
                  digest: 'conflict',
                },
              },
            }
          : {
              cursor: {
                position: null,
                epoch: reason === 'epoch-mismatch' ? 1 : 2,
                ...(reason === 'stranded' ? { stranded: true as const } : {}),
                ...(reason === 'incomplete' ? { incomplete: true as const } : {}),
              },
            },
        crypto.randomUUID(),
      )
    },
    comparisonEpoch: async (request) =>
      (JSON.parse(toUTF(request)) as { comparisonEpoch?: number }).comparisonEpoch,
    invalidateSigner() {
      trust.revoked.push('bob')
      source.trustDigest = toB64U(sha256(fromUTF(JSON.stringify(trust))))
    },
    snapshot: async () => ({
      attempt: (await requester.control().load()).rejoin,
      state: {
        bytes: requester.serializeState(),
        control: await requester.control().load(),
        source: await requester.readRecoverySource(),
      },
    }),
    close: async () => {},
  }
}

export async function createForkRecoveryMemoryFixture(): Promise<ForkRecoveryFixture> {
  const groupID = `fork-model-${crypto.randomUUID()}`
  let key = { groupID, incarnation: 1 }
  const options = { groupID, members: ['alice', 'bob'] }
  const own = createMemoryGroupMLS({ ...options, localDID: 'alice' })
  const other = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  await own.persistInitialState()
  await other.persistInitialState()
  for (let epoch = 0; epoch < 9; epoch++) {
    const commit = encodeMemoryCommit(epoch, 'bob', [], { branch: `common-${epoch}` })
    const result = await own.processCommit(commit, {})
    if (!result.advanced) throw new Error(`Model common commit refused: ${JSON.stringify(result)}`)
    other.adopt(commit)
  }
  const original = createMemoryGroupMLS({ ...options, localDID: 'bob' })
  original.restoreState(other.serializeState())
  const ownHeads = new Map<number, Uint8Array>([[9, original.serializeState()]])
  const otherHeads = new Map<number, Uint8Array>([[9, other.serializeState()]])
  for (let epoch = 9; epoch < 20; epoch++) {
    const commit = encodeMemoryCommit(epoch, 'alice', [], { branch: `own-${epoch}` })
    own.adopt(commit)
    await original.processCommit(commit, {})
    ownHeads.set(epoch + 1, original.serializeState())
  }
  for (let epoch = 9; epoch < 21; epoch++) {
    await other.processCommit(
      encodeMemoryCommit(epoch, 'alice', [], { branch: `other-${epoch}` }),
      {},
    )
    otherHeads.set(epoch + 1, other.serializeState())
  }
  const { createMemoryControlStore } = await import(
    '../../../rpc-conformance/src/memory-control-store.js'
  )
  let store = createMemoryControlStore<LogPosition>(key)
  const trust = { groupID, ownerDID: 'alice', members: ['alice', 'bob'] }
  const source = {
    key,
    identity: { ...key, epoch: 20, authenticator: own.authenticator() },
    stateVersion: 1,
    lifetimeRevision: 1,
    trust,
    trustDigest: toB64U(sha256(fromUTF(JSON.stringify(trust)))),
  }
  type ModelFact = {
    epoch: number
    authHash: string
    members: Array<{ did: string; keyHash: string }>
  }
  const facts = (
    JSON.parse(toUTF(original.serializeState())) as { rosterHistory: Array<ModelFact> }
  ).rosterHistory
  const splitState = otherHeads.get(10)
  if (splitState === undefined) throw new Error('Missing model split state')
  const branchFact = (
    JSON.parse(toUTF(splitState)) as { rosterHistory: Array<ModelFact> }
  ).rosterHistory.find((fact) => fact.epoch === 10)
  if (branchFact === undefined) throw new Error('Missing model fork')
  const noticeID = 'open-branch-notice'
  const check = async (attempt: ForkRecoveryAttempt, info: MemoryGroupInfo) => {
    const auth = attempt.forkRecovery
    const snapshot = await store.load()
    if (
      snapshot.forkHalt !== null ||
      snapshot.recoveryUnavailable !== null ||
      (snapshot.controlHold !== null && snapshot.controlHold.reason !== 'acceptance-unknown') ||
      attempt.id !== auth.attemptID ||
      attempt.source.groupID !== key.groupID ||
      attempt.source.incarnation !== key.incarnation ||
      auth.source.groupID !== key.groupID ||
      auth.source.incarnation !== key.incarnation
    )
      return false
    const offered = facts.find((fact) => fact.epoch === info.epoch)
    return (
      auth.noticeID === noticeID &&
      auth.splitEpoch === 10 &&
      info.epoch >= 10 &&
      info.signer === 'bob' &&
      auth.responderKeyHash === toB64U(sha256(fromUTF('bob'))) &&
      facts.find((fact) => fact.epoch === 9)?.members.some((member) => member.did === 'bob') ===
        true &&
      info.lineage?.some(
        (frame) => frame.epoch === 10 && frame.authHash === branchFact.authHash,
      ) === true &&
      (info.epoch > 20 ||
        (offered !== undefined && offered.authHash !== info.confirmedTranscriptHash))
    )
  }
  let adopting: CapturedRejoinRecord | undefined
  let builds = 0
  const make = () =>
    createMemoryGroupMLS({
      ...options,
      localDID: 'alice',
      capturedRecovery: {
        target: { targetID: 'repaired-hub', topicID: 'repaired-commits' },
        readSource: async () => source,
        accept: async (candidate) => {
          if (adopting === undefined || adopting.stage !== 'confirmed')
            throw new Error('Unconfirmed model recovery')
          const before = await store.load()
          key = { ...key, incarnation: key.incarnation + 1 }
          const adopted = { ...adopting, stage: 'adopted' as const, destinationKey: { ...key } }
          store = createMemoryControlStore<LogPosition>(key)
          await store.apply({ recoveryEpochFloor: before.recoveryEpochFloor }, 'installed-X')
          await store.retainForkContinuation({ ...before, rejoin: adopted })
          source.key = key
          source.identity = {
            ...key,
            epoch: adopting.epochAfter,
            authenticator: sha256(
              new Uint8Array([...adopting.target.groupInfoAuthenticator, ...candidate.commit]),
            ),
          }
          source.lifetimeRevision++
          adopting = undefined
        },
        readForkRecoveryAttempt: async () => (await store.load()).forkRecoveryAttempt ?? null,
        readRecoveryEpochFloor: async () => (await store.load()).recoveryEpochFloor,
        checkForkRecoveryCapture: check,
        settleForkRecoveryCapture: (record, result) => store.settleFork(record, result),
        async authoriseForkRecovery(reply, requestedNotice, info) {
          if (requestedNotice !== noticeID) return null
          const previous = (await store.load()).forkRecoveryAttempt
          if (previous != null) return (await check(previous, info)) ? previous.forkRecovery : null
          const id = crypto.randomUUID()
          const auth = {
            attemptID: id,
            noticeID,
            splitEpoch: 10,
            otherAuthHash: branchFact.authHash,
            responderKeyHash: toB64U(sha256(fromUTF('bob'))),
            source: key,
            evidence: reply.sealed.slice(),
          }
          const attempt = { id, source: key, forkRecovery: auth }
          if (!(await check(attempt, info))) return null
          await store.authoriseFork(attempt)
          return auth
        },
      },
    })
  let requester = make()
  const fixture: ForkRecoveryFixture = {
    get key() {
      return { ...key }
    },
    noticeID,
    requester: () => requester,
    builds: () => builds,
    snapshot: () => store.load(),
    async setOrdinaryFloor(epoch) {
      await store.apply({ recoveryEpochFloor: epoch }, crypto.randomUUID())
    },
    async seedEarlierSettlement() {
      const record = (await store.load()).rejoin
      if (record === null || !('format' in record)) throw new Error('Missing saved X')
      await store.apply(
        {
          putSettledRejoins: [
            {
              id: 'earlier-settlement',
              kind: 'not-accepted',
              epoch: 20,
              origin: { sourceKey: key, target: record.target, searchFrom: record.searchFrom },
              ledgerBefore: ['earlier-owed', 'shared'],
            },
          ],
        },
        crypto.randomUUID(),
      )
    },
    async ordinaryWrite(kind: 'delete' | 'unrelated' | 'wrong-source') {
      const control = store
      const record = (await control.load()).rejoin
      if (record === null || !('format' in record)) throw new Error('Missing bound Y')
      await control.apply(
        kind === 'delete'
          ? { deleteRejoin: true }
          : {
              putRejoin:
                kind === 'unrelated'
                  ? { ...record, id: 'unrelated-Z', forkRecovery: undefined }
                  : {
                      ...record,
                      source: {
                        ...record.source,
                        key: {
                          ...record.source.key,
                          incarnation: record.source.key.incarnation + 1,
                        },
                      },
                    },
            },
        crypto.randomUUID(),
      )
    },

    service: () => ({
      readRecords: async () => {
        const intent = (await store.load()).forkRecoveryAttempt
        if (intent == null) return []
        return (await store.forkHistory()).map((record) => ({
          kind: 'superseded-rejoin' as const,
          id: record.id,
          key: record.source.key,
          record,
          authorisation: intent.forkRecovery,
        }))
      },
    }),
    async reply(epoch = 12, branch: 'own' | 'other' = 'other', legacy = false) {
      const state = (branch === 'own' ? ownHeads : otherHeads).get(epoch)
      if (state === undefined) throw new Error('Missing model head')
      const responder = createMemoryGroupMLS({ ...options, localDID: 'bob' })
      if (branch === 'own' && !legacy) {
        const body = JSON.parse(toUTF(state)) as { rosterHistory: Array<ModelFact> }
        const otherState = otherHeads.get(epoch)
        if (otherState !== undefined) {
          const otherFacts = (JSON.parse(toUTF(otherState)) as { rosterHistory: Array<ModelFact> })
            .rosterHistory
          body.rosterHistory = [
            ...otherFacts.filter((fact) => fact.epoch < epoch),
            ...body.rosterHistory.filter((fact) => fact.epoch === epoch),
          ]
        }
        responder.restoreState(fromUTF(JSON.stringify(body)))
      } else responder.restoreState(state)
      const requestID = crypto.randomUUID()
      const held = await requester.createRecoveryRequest(
        requestID,
        undefined,
        legacy ? undefined : 10,
      )
      const sealed = await responder.sealGroupInfo(held.request, null)
      return { ...held, sealed, requestID, epochFloor: 20 }
    },
    async saveX(stage: 'built' | 'published' | 'confirmed' | 'adopted' = 'built') {
      const capture = await fixture.reply(20, 'own', true)
      const pending = await requester.capturedRecovery?.applyRecovery(
        capture.sealed,
        capture.requestID,
        capture.requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) throw new Error('Missing model X')
      const record = memoryCapturedRecord(
        pending,
        capture.request,
        capture.requestKey,
        capture.requestID,
      )
      record.stage = stage === 'adopted' ? 'confirmed' : stage
      record.ledgerBefore = ['owed-X', 'shared']
      if (stage !== 'built') record.position = asLogPosition('001')
      if (stage === 'confirmed' || stage === 'adopted') {
        const confirmation = await pending.confirmationKey('001', record.digest)
        record.candidate = pending.serialize()
        const state = ownHeads.get(20)
        if (state === undefined) throw new Error('Missing confirming state')
        const confirming = createMemoryGroupMLS({ ...options, localDID: 'bob' })
        confirming.restoreState(state)
        await confirming.processCommit(pending.commit, {})
        record.verdict = await confirming.sealRecoveryVerdict(capture.request, {
          groupID,
          requestID: capture.requestID,
          position: '001',
          commitDigest: record.digest,
          verdict: 'confirmed',
          epoch: pending.epoch,
          tag: encodeMultibase(hmac(sha256, confirmation, fromUTF(capture.requestID))),
        })
        record.switchMutationID = crypto.randomUUID()
      }
      await store.apply({ putRejoin: record, recoveryEpochFloor: 20 }, 'save-X')
      if (stage === 'adopted') {
        if (record.verdict === undefined) throw new Error('Missing confirmed verdict')
        adopting = record
        await pending.onAccepted(
          record.source,
          {
            ...record.target,
            position: asLogPosition('001'),
            payloadDigest: record.payloadDigest,
            verdict: record.verdict,
          },
          () => ({ mutationID: 'model-install-X', changes: {} }),
        )
        requester = make()
        return { ...record, stage: 'adopted', destinationKey: { ...key } }
      }
      return record
    },
    async build(
      authorisation: ForkRecoveryAuthorisation,
      capture: {
        sealed: Uint8Array
        requestID: string
        request: Uint8Array
        requestKey: Uint8Array
      },
    ) {
      const pending = await requester.capturedRecovery?.applyRecovery(
        capture.sealed,
        capture.requestID,
        capture.requestKey,
      )
      if (pending == null || 'renewalRequired' in pending) return null
      builds++
      const record = {
        ...memoryCapturedRecord(pending, capture.request, capture.requestKey, capture.requestID),
        id: authorisation.attemptID,
        forkRecovery: authorisation,
        ledgerBefore: (await store.load()).settledRejoins.flatMap((row) => row.ledgerBefore),
      }
      await store.apply({ putRejoin: record }, crypto.randomUUID())
      return { record, pending }
    },
    async restart() {
      requester = make()
    },
    close: async () => {},
  }
  return fixture
}
