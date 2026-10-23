import { decodeFrame } from '@kumiai/broadcast'

import { InvalidAppEntryError } from './app-frame.js'
import type { AppOutboxEntry } from './app-outbox.js'

export function decodeAppEntry(entry: AppOutboxEntry): { procedure: string; payload: unknown } {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(entry.data)
    const { payload } = decodeFrame(entry.data)
    if (payload?.typ !== 'event' || payload.prc !== entry.prc)
      throw new Error('App entry must contain its declared event procedure')
    return { procedure: entry.prc, payload: payload.data ?? {} }
  } catch (cause) {
    throw new InvalidAppEntryError('Invalid app outbox plaintext', { cause })
  }
}
