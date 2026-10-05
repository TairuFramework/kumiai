import { encodeMultibase } from '@kokuin/token'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

import type {
  GroupMLS,
  OpenedRecoveryVerdict,
  PendingRecovery,
  RecoveryRefusalReason,
} from './crypto.js'

export type RecoveryCommitOutcome = { commitDigest: string } & (
  | { kind: 'applied'; epoch: number; key: Uint8Array }
  | { kind: 'superseded' }
  | { kind: 'refused'; reason: RecoveryRefusalReason }
)

export function confirmationTag(key: Uint8Array, requestID: string): string {
  return encodeMultibase(hmac(sha256, key, new TextEncoder().encode(requestID)))
}

/** Expiry releases exporter keys even when the peer receives no further traffic. */
export function createRecoveryCache<T>(release: (value: T) => void = () => {}) {
  const entries = new Map<
    string,
    { value: T; expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >()
  const remove = (key: string): void => {
    const held = entries.get(key)
    if (held == null) return
    clearTimeout(held.timer)
    release(held.value)
    entries.delete(key)
  }
  return {
    get(key: string): { value: T; expiresAt: number } | undefined {
      const held = entries.get(key)
      if (held != null && held.expiresAt <= Date.now()) {
        remove(key)
        return
      }
      return held
    },
    set(key: string, value: T, expiresAt: number): void {
      remove(key)
      if (expiresAt <= Date.now()) {
        release(value)
        return
      }
      entries.set(key, {
        value,
        expiresAt,
        timer: setTimeout(() => remove(key), expiresAt - Date.now()),
      })
      while (entries.size > 1024) {
        const oldest = entries.keys().next().value
        if (oldest != null) remove(oldest)
      }
    },
    clear(): void {
      for (const key of entries.keys()) remove(key)
    },
  }
}

export type ConfirmationOutcome =
  | { kind: 'confirmed'; position: string; epoch: number }
  | { kind: 'superseded' }
  | { kind: 'refused'; refusal: RecoveryRefusalReason; responder: string }
  | { kind: 'unconfirmed'; advisory: Array<OpenedRecoveryVerdict> }
  | { kind: 'disposed' }
  | { kind: 'error'; error: unknown }

export function waitForRecoveryConfirmation(params: {
  port: GroupMLS
  pending: PendingRecovery
  groupID: string
  requestID: string
  position: string
  commitDigest: string
  key: Uint8Array
  deadline: number
  timeoutMs: number
  send: () => Promise<unknown>
  waiters: Map<string, { receive: (sealed: Uint8Array) => void; dispose: () => void }>
}): Promise<ConfirmationOutcome> {
  const {
    port,
    pending,
    groupID,
    requestID,
    position,
    commitDigest,
    key,
    deadline,
    timeoutMs,
    send,
    waiters,
  } = params
  return new Promise((resolve) => {
    let finished = false
    let settle: ReturnType<typeof setTimeout> | undefined
    let best: Extract<ConfirmationOutcome, { kind: 'superseded' | 'refused' }> | undefined
    const advisory = new Map<string, OpenedRecoveryVerdict>()
    let opening = Promise.resolve()
    const finish = (outcome: ConfirmationOutcome): void => {
      if (finished) return
      finished = true
      clearTimeout(end)
      clearInterval(repeat)
      if (settle != null) clearTimeout(settle)
      waiters.delete(requestID)
      key.fill(0)
      resolve(outcome)
    }
    const ask = (): void => {
      if (finished) return
      void send().catch((error: unknown) => finish({ kind: 'error', error }))
    }
    const end = setTimeout(
      () => finish(best ?? { kind: 'unconfirmed', advisory: [...advisory.values()] }),
      Math.max(0, deadline - Date.now()),
    )
    const repeat = setInterval(ask, timeoutMs)
    waiters.set(requestID, {
      dispose: () => finish({ kind: 'disposed' }),
      receive: (sealed) => {
        opening = opening
          .then(async () => {
            if (finished) return
            const opened = await port.openRecoveryVerdict(sealed, requestID)
            if (finished || opened == null) return
            const verdict = opened.verdict
            if (
              verdict.groupID !== groupID ||
              verdict.requestID !== requestID ||
              verdict.position !== position ||
              verdict.commitDigest !== commitDigest
            )
              return
            if (
              verdict.verdict === 'confirmed' &&
              (verdict.epoch !== pending.epoch || verdict.tag !== confirmationTag(key, requestID))
            )
              return
            if (pending.judgeVerdict(opened) === 'advisory') {
              advisory.set(JSON.stringify(opened), opened)
              if (advisory.size > 1024) {
                const oldest = advisory.keys().next().value
                if (oldest != null) advisory.delete(oldest)
              }
              return
            }
            if (verdict.verdict === 'confirmed') {
              finish({ kind: 'confirmed', position, epoch: pending.epoch })
              return
            }
            if (verdict.verdict === 'superseded') best = { kind: 'superseded' }
            else if (best == null)
              best = { kind: 'refused', refusal: verdict.reason, responder: opened.signer }
            if (settle == null) {
              clearInterval(repeat)
              settle = setTimeout(
                () => finish(best ?? { kind: 'unconfirmed', advisory: [...advisory.values()] }),
                Math.min(timeoutMs, Math.max(0, deadline - Date.now())),
              )
              ask()
            }
          })
          .catch((error: unknown) => finish({ kind: 'error', error }))
      },
    })
    ask()
  })
}
