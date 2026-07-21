import type { TransportType } from '@enkaku/transport'
import { Disposer } from '@sozai/async'
import { createRuntime, type Runtime } from '@sozai/runtime'

import { buildEventMessage } from './event-frame.js'
import type { BroadcastMessage } from './transport.js'

export type RequestData = { kind: 'req'; rid: string; prm: unknown; gather?: boolean }
/**
 * A reply body: WHAT the answer is, never WHO gave it. The sender travels at the transport level
 * as `BroadcastMessage.senderDID`, settable only by an authenticating `unwrap` — there is no
 * second place for a responder to name itself. Never add a `from` field here: anything a
 * responder writes into its own reply is a self-asserted claim, not an identity.
 */
export type ReplyData = { kind: 'res'; rid: string; ok?: unknown; err?: string }

export type RequestOptions = { errorThreshold?: number; timeoutMs?: number }
export type GatherOptions = { quorum?: number; timeoutMs?: number }
/**
 * One gathered reply, attributed to the AUTHENTICATED sender the transport established — never a
 * self-asserted `from` in the reply body.
 */
export type GatheredReply = { senderDID: string; value: unknown }

export type BroadcastClientParams = {
  transport: TransportType<BroadcastMessage, BroadcastMessage>
  /** Runtime providing platform primitives. Defaults to `createRuntime()`. */
  runtime?: Runtime
}

const DEFAULT_TIMEOUT_MS = 5000

type PendingEntry = {
  /** `senderDID` is separate from `reply` because it is not the responder's to state. */
  collect: (reply: ReplyData, senderDID: string) => void
  onDispose: () => void
}

export class BroadcastClient extends Disposer {
  #transport: TransportType<BroadcastMessage, BroadcastMessage>
  #getRandomID: () => string
  #pending: Map<string, PendingEntry> = new Map()

  constructor(params: BroadcastClientParams) {
    super({
      dispose: async (reason?: unknown) => {
        // Snapshot and clear before settling so in-flight collect() calls are no-ops.
        const entries = [...this.#pending.values()]
        this.#pending.clear()
        for (const entry of entries) {
          entry.onDispose()
        }
        await this.#transport.dispose(reason)
      },
    })
    this.#transport = params.transport
    this.#getRandomID = (params.runtime ?? createRuntime()).getRandomID
    // Discard the promise intentionally; read errors are best-effort here.
    void this.#read().catch(() => {})
  }

  async #read(): Promise<void> {
    for await (const msg of this.#transport) {
      const payload = msg?.payload
      if (payload?.typ !== 'event') {
        continue
      }
      const data = payload.data as Partial<ReplyData> | undefined
      if (data?.kind !== 'res' || typeof data.rid !== 'string') {
        continue
      }
      // A reply this transport can't attribute is DROPPED, not delivered unattributed — an
      // authenticating transport clears `senderDID` when the open recovers no identity, so only a
      // sender the transport itself established gets through. Applies to every reply, not just
      // gathered ones, since `request` resolves on the first accepted answer.
      const senderDID = (msg as { senderDID?: unknown }).senderDID
      if (typeof senderDID !== 'string' || senderDID === '') {
        continue
      }
      this.#pending.get(data.rid)?.collect(data as ReplyData, senderDID)
    }
  }

  async dispatch(prc: string, data: Record<string, unknown> = {}): Promise<void> {
    await this.#transport.write(buildEventMessage(prc, data))
  }

  async request(prc: string, prm: unknown = {}, options: RequestOptions = {}): Promise<unknown> {
    const rid = this.#getRandomID()
    const errorThreshold = options.errorThreshold ?? Number.POSITIVE_INFINITY
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<unknown>((resolve, reject) => {
      let errorCount = 0
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`Broadcast request "${prc}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.#pending.delete(rid)
      }
      this.#pending.set(rid, {
        collect: (reply) => {
          if (reply.err != null) {
            errorCount += 1
            if (errorCount >= errorThreshold) {
              cleanup()
              reject(new Error(`Broadcast request "${prc}" failed after ${errorCount} errors`))
            }
            return
          }
          cleanup()
          resolve(reply.ok)
        },
        // Reject immediately on dispose rather than wait for the timeout.
        onDispose: () => {
          clearTimeout(timer)
          reject(new Error('BroadcastClient disposed'))
        },
      })
      this.#transport
        .write({ payload: { typ: 'event', prc, data: { kind: 'req', rid, prm } } })
        .catch((error) => {
          cleanup()
          reject(error)
        })
    })
  }

  async gather(
    prc: string,
    prm: unknown = {},
    options: GatherOptions = {},
  ): Promise<Array<GatheredReply>> {
    const rid = this.#getRandomID()
    const quorum = options.quorum ?? Number.POSITIVE_INFINITY
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<Array<GatheredReply>>((resolve, reject) => {
      const replies: Array<GatheredReply> = []
      const seen = new Set<string>()
      const finish = () => {
        clearTimeout(timer)
        this.#pending.delete(rid)
        resolve(replies)
      }
      const timer = setTimeout(finish, timeoutMs)
      this.#pending.set(rid, {
        // Keyed on the AUTHENTICATED sender — that's what makes this a quorum rather than a frame
        // count. Keyed on an asserted name instead, one member could suppress another's real
        // answer by racing a forgery under its DID, or reach a quorum of N alone by answering N
        // times under N names.
        collect: (reply, senderDID) => {
          if (reply.err != null || seen.has(senderDID)) {
            return
          }
          seen.add(senderDID)
          replies.push({ senderDID, value: reply.ok })
          if (replies.length >= quorum) {
            finish()
          }
        },
        // Resolve with partial replies on dispose rather than wait for the timeout.
        onDispose: () => {
          clearTimeout(timer)
          resolve(replies)
        },
      })
      this.#transport
        .write({ payload: { typ: 'event', prc, data: { kind: 'req', rid, prm, gather: true } } })
        // Reject on write failure rather than silently resolving with no replies.
        .catch((error) => {
          clearTimeout(timer)
          this.#pending.delete(rid)
          reject(error)
        })
    })
  }
}
