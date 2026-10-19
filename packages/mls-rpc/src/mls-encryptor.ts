import { normalizeDID } from '@kokuin/token'
import {
  decodeEnvelope,
  decodeFrame,
  type Encryptor,
  type HubFrame,
  type MailboxHub,
} from '@kumiai/hub-tunnel'
import { FrameEpochError } from '@kumiai/rpc'
import { toB64 } from '@sozai/codec'

import type { GroupRuntimeSnapshot, RegistryHandleAccess } from './registry/types.js'

export type MLSEncryptorParams = {
  access: Pick<RegistryHandleAccess, 'seal' | 'receive' | 'runtime' | 'key'>
  peerDID: string
  role: 'dialer' | 'listener'
}

function requestID(frame: HubFrame): string | null {
  if (frame.kind !== 'message') return null
  const { typ, rid } = frame.body.payload
  return (typ === 'request' || typ === 'stream' || typ === 'channel') && typeof rid === 'string'
    ? rid
    : null
}

function replyID(frame: HubFrame): string | null {
  if (frame.kind !== 'message') return null
  const { typ, rid } = frame.body.payload
  return (typ === 'result' || typ === 'receive' || typ === 'error') && typeof rid === 'string'
    ? rid
    : null
}

export class MLSEncryptor implements Encryptor {
  #access: MLSEncryptorParams['access']
  #peerDID: string
  #role: 'dialer' | 'listener'
  #clearGeneration = 0
  #outstanding = new Map<string, Set<string>>()
  #pendingPublish = new Map<string, { sessionID: string; rid: string }>()
  #closeForRemoval: (() => void) | undefined
  #pending: Array<{
    ciphertext: Uint8Array
    resolve: (bytes: Uint8Array) => void
    reject: (reason: unknown) => void
  }> = []
  #inFlight: Map<string, Promise<Uint8Array>> = new Map()
  #flushScheduled = false

  constructor(params: MLSEncryptorParams) {
    this.#access = params.access
    this.#peerDID = normalizeDID(params.peerDID)
    this.#role = params.role
  }

  async encrypt(plaintext: Uint8Array): Promise<Uint8Array> {
    const frame = decodeFrame(plaintext)
    const clearGeneration = this.#clearGeneration
    const { ciphertext: encrypted } = await this.#access.seal(plaintext, {
      aad: new Uint8Array(),
      intent: 'ephemeral',
    })
    if (this.#role === 'dialer' && clearGeneration === this.#clearGeneration) {
      const rid = requestID(frame)
      if (rid !== null) {
        const pending = this.#outstanding.get(frame.sessionID) ?? new Set<string>()
        pending.add(rid)
        this.#outstanding.set(frame.sessionID, pending)
        this.#pendingPublish.set(toB64(encrypted), { sessionID: frame.sessionID, rid })
      } else if (frame.kind === 'session-end') {
        this.#retireSession(frame.sessionID)
      } else if (frame.kind === 'message' && frame.body.payload.typ === 'abort') {
        const cancelled = frame.body.payload.rid
        if (typeof cancelled === 'string') this.#retireRequest(frame.sessionID, cancelled)
      }
    }
    return encrypted
  }

  trackPublish(hub: MailboxHub): MailboxHub {
    return {
      ...hub,
      publish: async (params) => {
        let ciphertext: string | undefined
        try {
          ciphertext = decodeEnvelope(params.payload).ciphertext
        } catch {
          // Forward a malformed payload to the hub unchanged.
        }
        try {
          return await hub.publish(params)
        } catch (error) {
          const pending =
            ciphertext === undefined ? undefined : this.#pendingPublish.get(ciphertext)
          if (pending !== undefined) this.#retireRequest(pending.sessionID, pending.rid)
          throw error
        } finally {
          if (ciphertext !== undefined) this.#pendingPublish.delete(ciphertext)
        }
      },
    }
  }

  clear(): void {
    this.#clearGeneration++
    this.#outstanding.clear()
    this.#pendingPublish.clear()
  }

  #retireRequest(sessionID: string, rid: string): void {
    const pending = this.#outstanding.get(sessionID)
    pending?.delete(rid)
    if (pending?.size === 0) this.#outstanding.delete(sessionID)
    for (const [ciphertext, published] of this.#pendingPublish) {
      if (published.sessionID === sessionID && published.rid === rid)
        this.#pendingPublish.delete(ciphertext)
    }
  }

  #retireSession(sessionID: string): void {
    this.#outstanding.delete(sessionID)
    for (const [ciphertext, published] of this.#pendingPublish) {
      if (published.sessionID === sessionID) this.#pendingPublish.delete(ciphertext)
    }
  }

  watchPeerRemoval(dispose: () => Promise<void>): () => void {
    let active = true
    let unsubscribe: (() => void) | undefined
    const unwatch = () => {
      active = false
      unsubscribe?.()
      unsubscribe = undefined
      if (this.#closeForRemoval === close) this.#closeForRemoval = undefined
    }
    let observedEpoch: number | undefined
    let incarnation: number | undefined
    const close = () => {
      if (!active) return
      unwatch()
      this.clear()
      try {
        void dispose().catch(() => {})
      } catch {
        // Disposal cannot interrupt runtime notifications.
      }
    }
    this.#closeForRemoval = close
    const check = (value: GroupRuntimeSnapshot | null) => {
      if (!active) return
      try {
        if (
          value === null ||
          !value.available ||
          !value.members.has(this.#peerDID) ||
          (incarnation !== undefined && value.incarnation !== incarnation) ||
          (observedEpoch !== undefined &&
            (value.epoch < observedEpoch || value.epoch > observedEpoch + 1))
        ) {
          close()
          return
        }
        incarnation = value.incarnation
        if (observedEpoch === undefined || value.epoch === observedEpoch + 1)
          observedEpoch = value.epoch
      } catch {
        close()
      }
    }
    try {
      check(this.#access.runtime.snapshot())
    } catch {
      close()
    }
    if (active) {
      unsubscribe = this.#access.runtime.onEpochChanged(check)
      if (!active) unwatch()
    }
    return unwatch
  }

  decrypt(ciphertext: Uint8Array): Promise<Uint8Array> {
    const key = toB64(ciphertext)
    const cached = this.#inFlight.get(key)
    if (cached != null) return cached
    const promise = new Promise<Uint8Array>((resolve, reject) => {
      this.#pending.push({ ciphertext, resolve, reject })
      if (!this.#flushScheduled) {
        this.#flushScheduled = true
        queueMicrotask(() => this.#flush())
      }
    })
    this.#inFlight.set(key, promise)
    void promise
      .finally(() => {
        this.#inFlight.delete(key)
      })
      .catch(() => {})
    return promise
  }

  #flush(): void {
    this.#flushScheduled = false
    const batch = this.#pending.splice(0)
    void (async () => {
      for (let offset = 0; offset < batch.length; offset += 64) {
        const chunk = batch.slice(offset, offset + 64)
        const outcomes = await this.#access.receive(
          chunk.map(({ ciphertext }) => ({ ciphertext, expectedAAD: new Uint8Array() })),
        )
        outcomes.forEach((outcome, index) => {
          const item = chunk[index] as (typeof batch)[number]
          try {
            if (outcome.kind !== 'opened') {
              if (outcome.reason === 'past-epoch' || outcome.reason === 'future-epoch')
                throw new FrameEpochError(outcome.frameEpoch, outcome.handleEpoch)
              throw new Error(`MLS receive refused: ${outcome.reason}`, { cause: outcome })
            }
            const { payload, senderDID, frameEpoch, handleEpoch } = outcome
            if (senderDID !== undefined && normalizeDID(senderDID) !== this.#peerDID)
              throw new Error('MLS sender does not match hub publisher')
            const snapshot = this.#access.runtime.snapshot()
            if (
              snapshot === null ||
              snapshot.incarnation !== this.#access.key.incarnation ||
              snapshot.epoch < handleEpoch
            )
              throw new Error('MLS membership snapshot does not cover the receive handle')
            if (!snapshot.members.has(this.#peerDID)) {
              this.clear()
              this.#closeForRemoval?.()
              throw new Error('MLS peer is no longer a group member')
            }
            const frame = decodeFrame(payload)
            if (senderDID === undefined || frameEpoch !== handleEpoch) {
              if (
                this.#role === 'dialer' &&
                frame.kind === 'session-end' &&
                this.#outstanding.has(frame.sessionID)
              ) {
                this.#retireSession(frame.sessionID)
              }
              const rid = replyID(frame)
              if (
                this.#role !== 'dialer' ||
                rid === null ||
                !this.#outstanding.get(frame.sessionID)?.has(rid)
              )
                throw new Error('MLS stale or nameless frame is not an outstanding reply')
            }
            if (this.#role === 'dialer' && frame.kind === 'session-end')
              this.#retireSession(frame.sessionID)
            const rid = replyID(frame)
            if (
              this.#role === 'dialer' &&
              rid !== null &&
              frame.kind === 'message' &&
              (frame.body.payload.typ === 'result' || frame.body.payload.typ === 'error')
            ) {
              this.#retireRequest(frame.sessionID, rid)
            }
            item.resolve(payload)
          } catch (error) {
            item.reject(error)
          }
        })
      }
    })().catch((error: unknown) => {
      for (const item of batch) item.reject(error)
    })
  }
}
