import type { AppOutboxEntry } from './app-outbox.js'
import type { EpochIdentity } from './control/types.js'

export type AppPublicationSnapshot = {
  identity: EpochIdentity
  stateVersion: number
  sealVersion: number
  segment: number
  topicID: string
}
export type PreparedAppPublication = {
  entry: AppOutboxEntry
  payload: Uint8Array
  snapshot: AppPublicationSnapshot
}
export type AppPublicationPort = {
  /** Check caller ownership synchronously, without acquiring storage or waiting for proof. */
  assertRoot(): void
  prepare(entry: AppOutboxEntry, floor: string | null): Promise<PreparedAppPublication>
  snapshot(protocol: string): Promise<AppPublicationSnapshot | null>
}
