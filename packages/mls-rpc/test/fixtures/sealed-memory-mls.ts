import {
  type ClientState,
  decodeClientState,
  encodeClientState,
  type GroupHandle,
  type MemberCredential,
} from '@kumiai/mls'
import {
  type ControlValidationPort,
  decodeCommitFrame,
  decodeHandshakeFrame,
  decodeLedgerEntries,
  type GroupMLS,
  type HostBuilt,
  type Operation,
} from '@kumiai/rpc'
import { sha256 } from '@noble/hashes/sha2.js'
import { toB64U } from '@sozai/codec'

import { decodeControlJournal } from '../../src/control-journal.js'
import { ENTRY_SEAL_LABEL, openEntries } from '../../src/crypto.js'
import { decodeStoredValue } from '../../src/persistence-codec.js'

type MemoryMLS = GroupMLS & {
  epoch(): number
  authenticator(): Uint8Array
  serializeState(): Uint8Array
  restoreState(bytes: Uint8Array): void
  buildCommit(tokens?: Array<string>, options?: { adds?: Array<string> }): Uint8Array
  adopt(commit: Uint8Array): void
}

const { createMemoryGroupMLS } = (await import(
  new URL('../../../rpc/test/fixtures/memory-group-mls.ts', import.meta.url).href
)) as {
  createMemoryGroupMLS(params: {
    groupID: string
    localDID?: string
    epoch: number
    recoverySecret: Uint8Array
    members?: Array<string>
  }): MemoryMLS
}
const { fakeEpochSecret } = (await import(
  new URL('../../../rpc/test/fixtures/fake-crypto.ts', import.meta.url).href
)) as {
  fakeEpochSecret(epoch: number, label: string, length: number, secret: Uint8Array): Uint8Array
}

function model(
  state: ClientState,
  credential: MemberCredential,
  restore = true,
  receiver = false,
): MemoryMLS {
  const mls = createMemoryGroupMLS({
    groupID: credential.groupID,
    ...(receiver ? {} : { localDID: credential.id }),
    epoch: Number(state.groupContext.epoch),
    recoverySecret: state.keySchedule.exporterSecret,
    members: [credential.id],
  })
  if (restore) mls.restoreState(state.confirmationTag)
  return mls
}

function envelope(state: ClientState, mls: MemoryMLS): ClientState {
  return {
    ...state,
    groupContext: { ...state.groupContext, epoch: BigInt(mls.epoch()) },
    keySchedule: { ...state.keySchedule, epochAuthenticator: mls.authenticator() },
    // The v2 storage envelope retains the independent double's entire durable state.
    confirmationTag: mls.serializeState(),
  }
}

export function seedMemoryControlState(state: ClientState, credential: MemberCredential) {
  return envelope(state, model(state, credential, false))
}

const models = new WeakMap<GroupHandle, MemoryMLS>()

export function memoryModel(handle: GroupHandle): MemoryMLS {
  const mls = models.get(handle)
  if (mls === undefined) throw new Error('Not an independent memory handle')
  return mls
}

export async function restoreMemoryControlHandle(params: {
  state: ClientState
  credential: MemberCredential
  ledgerEntries: Array<string>
}): Promise<GroupHandle> {
  const { state, credential, ledgerEntries } = params
  const mls = model(state, credential)
  const exporter = (label: string, _context: Uint8Array, length: number) =>
    Promise.resolve(fakeEpochSecret(mls.epoch(), label, length, state.keySchedule.exporterSecret))
  // The adapter only needs this structural handle surface; MLS behaviour belongs to the double.
  const handle = {
    state,
    credential,
    groupID: credential.groupID,
    epoch: BigInt(mls.epoch()),
    ledgerTokens: [...ledgerEntries],
    registry: { devices: new Map(), controllers: new Map() },
    exportSecret: exporter,
    sendAdmission: () => mls.sendAdmission(),
    carryReceiveProgress: async (next: GroupHandle) => {
      if (next.groupID !== credential.groupID || next.epoch !== BigInt(mls.epoch() + 1))
        throw new Error('Memory candidate source changed')
    },
    confirmAdopted: () => {},
  } as unknown as GroupHandle
  models.set(handle, mls)
  return handle
}

export async function buildSealedMemoryOperation(
  op: Operation,
  handle: GroupHandle,
): Promise<HostBuilt> {
  const mls = memoryModel(handle)
  const before = mls.serializeState()
  const epoch = mls.epoch()
  const authenticatorBefore = mls.authenticator()
  const { target } = decodeStoredValue(op.body) as { target: string }
  const commit = mls.buildCommit([], { adds: [target] })
  mls.adopt(commit)
  const candidate = encodeClientState(envelope(handle.state, mls))
  mls.restoreState(before)
  return {
    commit,
    bodies: [],
    journal: candidate,
    welcome: { bytes: new TextEncoder().encode(target), recipients: [target] },
    incarnation: 1,
    epoch,
    authenticatorBefore,
    digest: toB64U(sha256(commit)),
  }
}

export function sealedMemoryValidation(): ControlValidationPort {
  return {
    async restoreValidation(built) {
      const journal = decodeControlJournal(built.journal)
      const state = decodeClientState(journal.sourceState)
      const identity = journal.source.identity
      if (
        state === undefined ||
        identity === null ||
        journal.checkpoint !== built.searchFrom ||
        built.epoch !== identity.epoch ||
        built.incarnation !== identity.incarnation ||
        toB64U(built.authenticatorBefore) !== toB64U(identity.authenticator) ||
        toB64U(sha256(built.payload)) !== built.payloadDigest
      )
        return null
      const source = () => model(state, journal.sourceCredential, true, true)
      const check = async (payload: Uint8Array) => {
        const { commit, sealedEntries } = decodeCommitFrame(decodeHandshakeFrame(payload).payload)
        const working = source()
        const result = await working.processCommit(commit, {
          resolveLedgerEntries: async () =>
            decodeLedgerEntries(
              openEntries(
                fakeEpochSecret(
                  identity.epoch,
                  ENTRY_SEAL_LABEL,
                  32,
                  state.keySchedule.exporterSecret,
                ),
                sealedEntries,
              ),
            ),
        })
        return { working, result, header: await source().readCommitHeader(commit) }
      }
      return {
        source: journal.source,
        readCommitHeader: (commit) => source().readCommitHeader(commit),
        verifyOwn: async (value) => {
          if (toB64U(value.payload) !== toB64U(built.payload)) return false
          const candidate = decodeClientState(journal.candidate)
          if (candidate === undefined) return false
          const checked = await check(value.payload)
          return (
            checked.result.applied &&
            checked.header?.external !== true &&
            checked.header?.committerDID === journal.sourceCredential.id &&
            checked.working.epoch() === Number(candidate.groupContext.epoch) &&
            toB64U(checked.working.authenticator()) ===
              toB64U(candidate.keySchedule.epochAuthenticator)
          )
        },
        validateFrame: async (frame) => {
          try {
            const { result, header } = await check(frame.payload)
            if (!result.applied || header === null) return { kind: 'invalid', reason: 'policy' }
            return {
              kind: 'valid',
              header,
              advanced: result.advanced,
              removed: false,
              own: header.external !== true && header.committerDID === journal.sourceCredential.id,
            }
          } catch {
            return { kind: 'unavailable', reason: 'resolver' }
          }
        },
      }
    },
  }
}
