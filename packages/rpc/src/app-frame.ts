import { BROADCAST_VERSION } from '@kumiai/broadcast'

import type { GroupKey } from './control/types.js'
import { isWellFormedUTF16 } from './well-formed.js'

export type AppEventPlaintext = { procedure: string; data: Record<string, unknown> }

export const RETAINED_EPOCHS_DEFAULT = 4
export const RETAINED_EPOCHS_MAX = 32

export class InvalidAppEntryError extends Error {
  override name = 'InvalidAppEntryError'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function decodeAppEventPlaintext(bytes: Uint8Array): AppEventPlaintext | null {
  try {
    const frame: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!isPlainObject(frame) || frame.v !== BROADCAST_VERSION) return null
    const payload = frame.payload
    if (!isPlainObject(payload) || payload.typ !== 'event') return null
    const procedure = payload.prc
    if (typeof procedure !== 'string' || procedure.length === 0 || !isWellFormedUTF16(procedure)) {
      return null
    }
    const data = payload.data === undefined ? {} : payload.data
    return isPlainObject(data) ? { procedure, data } : null
  } catch {
    return null
  }
}

export function appFrameIdempotencyKey(
  frame: GroupKey & { topicID: string; position: string; protocol: string; procedure: string },
): string {
  return JSON.stringify([
    'kumiai/frame/v1',
    frame.groupID,
    frame.incarnation,
    frame.topicID,
    frame.position,
    frame.protocol,
    frame.procedure,
  ])
}

export function isAppLogPosition(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64
}
