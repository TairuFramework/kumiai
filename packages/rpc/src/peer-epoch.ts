import type { Client } from '@enkaku/client'
import type { ProtocolDefinition } from '@enkaku/protocol'
import type { ProcedureHandlers } from '@enkaku/server'
import { normalizeDID } from '@kokuin/token'
import {
  BroadcastClient,
  createBroadcastResponder,
  createBroadcastTransport,
  encodeEventFrame,
  type SuppressConfig,
} from '@kumiai/broadcast'
import type { StoredMessage } from '@kumiai/hub-protocol'
import type { Runtime } from '@sozai/runtime'

import type { Anchor } from './anchor.js'
import { decodeAppAAD, encodeAppAAD } from './app-aad.js'
import type { AppLane } from './app-lane.js'
import { type GroupCrypto, type GroupUnwrapResult, isFrameAhead } from './crypto.js'
import {
  createDirectedClient,
  createInboxAcceptor,
  createInboxPath,
  createUnroutedTagResponder,
  type InboundPath,
} from './directed.js'
import { assertFrameFits } from './frame-size.js'
import { adaptBusHandlers } from './handlers.js'
import { type HostBoundary, wrapGatherOptions } from './host-boundary.js'
import type { HubMux } from './hub-mux.js'
import { createOpenOncePath } from './open-once.js'
import type { GroupPeerParams, InternalSurface } from './peer-types.js'
import { retentionOf } from './protocol.js'
import { inboxTopic, protocolTopic } from './topic.js'

/**
 * A protocol's live lane at the epoch it was built for. Holds no topic ID: the topic is
 * anchor-bound and stable within a segment, but a runtime rebuilds only once a whole commit walk
 * returns, so what it remembers can be a segment out of date. A publisher asks the live anchor
 * instead (see `sealForSegment`).
 */
type ProtocolRuntime = {
  client: BroadcastClient
  busServer: { dispose: () => Promise<void> }
  acceptor: { dispose: () => Promise<void> }
  directed: Map<string, { client: Client<ProtocolDefinition>; dispose: () => Promise<void> }>
}

/** A frame sealed for, and addressed to, the segment its seal epoch belongs to. */
export type SegmentFrame = { topicID: string; payload: Uint8Array }

export type EpochRuntimeParams<Protocols extends Record<string, ProtocolDefinition>> = {
  boundary: HostBoundary
  mux: HubMux
  crypto: GroupCrypto
  localDID: string
  protocols: Protocols
  handlers: GroupPeerParams<Protocols>['handlers']
  suppress: SuppressConfig | undefined
  runtime: Runtime | undefined
  appLogRetentionSeconds: number
  /** Read at every derivation, never captured: the anchor moves under a live epoch. */
  anchor: () => Anchor
  /** Pending while an advance can move the handle before its new anchor is captured. */
  sealBarrier: () => Promise<void> | undefined
  /** Set while the anchor needs confirmed recovery; every seal refuses with it. */
  sealError: () => Error | undefined
  isDisposed: () => boolean
  note: AppLane['note']
  requestAppPull: () => void
}

export type EpochRuntime = {
  buildEpoch: () => Promise<void>
  teardownEpoch: () => Promise<void>
  /** Teardown then build; a teardown failure still builds, then rethrows. */
  rebuildEpoch: () => Promise<void>
  surfaceFor: (name: string) => InternalSurface
  sealForSegment: (
    name: string,
    bytes: Uint8Array,
    intent?: 'ephemeral' | 'log',
  ) => Promise<SegmentFrame>
  hasInboxLane: () => boolean
  /** Dispose-only: `to()` has no lane left to build a directed client against. */
  releaseInboxLane: () => void
}

/** The app lane's anchor-bound runtimes per protocol, plus the peer's one inbox lane. */
export function createEpochRuntime<Protocols extends Record<string, ProtocolDefinition>>(
  params: EpochRuntimeParams<Protocols>,
): EpochRuntime {
  const {
    boundary,
    mux,
    crypto,
    localDID,
    protocols,
    handlers,
    suppress,
    appLogRetentionSeconds,
    anchor,
    sealBarrier,
    sealError,
    isDisposed,
  } = params

  let runtimes = new Map<string, ProtocolRuntime>()

  /**
   * The epoch's self-inbox topic and the one path that opens its frames. Held per peer rather
   * than per protocol because the topic is not per protocol, and rebuilt with the epoch — the
   * topic is anchor-bound, so a roster change moves it.
   */
  let inboxLane: { topicID: string; path: InboundPath } | undefined

  /**
   * The one peer-level consumer of the shared inbox path that NACKs a frame tagged for a protocol
   * no acceptor here serves — every acceptor filters on its own tag, so such a frame would
   * otherwise be dropped silently. Rebuilt with the epoch, since it replies on the anchor-bound
   * inbox topics the rotation moves.
   */
  let unroutedTagResponder: { dispose: () => void } | undefined

  /**
   * The opened form of a live frame, keyed by the plaintext the open produced. Written by the
   * inbound path below and read by every transport built on it, so one open serves all of them.
   *
   * {@link GroupUnwrapResult}, not `@kumiai/broadcast`'s `UnwrapResult`: what is stored here
   * reaches `BroadcastClient.gather` as the sender it keys its quorum on, and broadcast's type
   * says `senderDID?`. `crypto.unwrap` REQUIRES the field, so the narrowing below checks a promise
   * already made — a frame that breaks it is refused rather than fanned out.
   */
  const openedFrames = new WeakMap<Uint8Array, GroupUnwrapResult>()

  /**
   * Whether a frame `unwrap` just refused might still open once this handle catches up — read from
   * the refusal's locked answer ({@link "crypto".FrameEpochError}), never the epoch hint.
   * On the open-once failure path ({@link "open-once".OpenOncePathParams.retainOnFailure}) answering
   * `true` withholds the ack so the frame survives a reconnect. Mailbox-class frames have no staging
   * of their own (unlike `app-lane.ts`'s `note`/`ahead`), which is what made acking a transient
   * refusal here a permanent loss.
   */
  const retainOnFailure = (_message: StoredMessage, error: unknown): boolean => isFrameAhead(error)

  /**
   * The app lane's inbound path: one open per topic, fanned out as plaintext, with each frame's
   * log position noted once its open settles. Every consumer's own `unwrap` is then a pure lookup of the
   * opened result ({@link openedFrames}), and nothing downstream touches the handle.
   *
   * See {@link createOpenOncePath} for why a lane may only open a frame once.
   */
  const createInboundPath = (name: string, topicID: string) => {
    return createOpenOncePath<Uint8Array>({
      mux,
      topicID,
      unwrap: (b) => {
        const hinted = crypto.frameAAD(b)
        const decoded = hinted == null ? null : decodeAppAAD(hinted)
        const intent = decoded?.topicID === topicID ? decoded.intent : 'ephemeral'
        return crypto.unwrap(b, { expectedAAD: encodeAppAAD({ topicID, intent }) })
      },
      retainOnFailure,
      project: (_message, opened) => {
        const { payload, senderDID } = opened
        if (typeof senderDID !== 'string' || senderDID === '') {
          // `project` returning `undefined` drops the frame deliberately (see
          // `OpenOncePathParams.project`): the app lane is always MLS-sealed, so an open that
          // recovers no sender is not a frame to deliver unattributed. Fails CLOSED against the
          // shared open-once signature's wider `UnwrapResult`.
          return undefined
        }
        // Normalized at the open, before it is keyed: every consumer of `openedFrames` (the
        // acceptor, `gather`'s quorum) must see one canonical sender regardless of which DID form
        // MLS recovered this frame under.
        openedFrames.set(payload, { ...opened, senderDID: normalizeDID(senderDID) })
        return payload
      },
      note: (message, failure) => params.note(name, topicID, message, failure),
      wakeup: (message) => {
        if (crypto.pending == null) return false
        const aad = crypto.frameAAD(message.payload)
        if (aad == null || decodeAppAAD(aad)?.intent !== 'log') return false
        params.requestAppPull()
        return true
      },
    })
  }

  /**
   * One protocol's live-lane transport: LISTENS on the topic the runtime is built for, and
   * PUBLISHES to the segment that contains each frame's own seal epoch — see
   * {@link sealForSegment} for why those can differ mid-rotation.
   *
   * The topic is decided by the SEAL and carried to the publish, since the two are separate calls
   * with an anchor that can move between them: `wrap` records the topic under the ciphertext it
   * produced, keyed by the bytes' own identity rather than a slot, since two transports share this
   * lane and interleave their writes.
   *
   * The subscribe keeps the runtime's topic — a rotation rebuilds the listeners, but a topic stays
   * subscribed at the mux for the member's whole life either way.
   */
  const segmentBoundTransport = (
    name: string,
    topicID: string,
    inbound: (onOpened: (payload: Uint8Array) => void) => () => void,
  ) => {
    const sealedOn = new WeakMap<Uint8Array, string>()
    return createBroadcastTransport({
      topicID,
      bus: {
        // `builtFor` is the topic this transport was constructed with, and it is the fallback
        // rather than the answer: anything published through here was sealed by the `wrap` below,
        // so the recorded topic is the one that agrees with the seal.
        publish: async (builtFor, payload) => {
          await mux.bus.publish(sealedOn.get(payload) ?? builtFor, payload)
        },
        // Already-opened plaintext, from the topic's one inbound path. The `unwrap` below only
        // recovers the sender the open already authenticated.
        subscribe: (_listenOn, onMessage) => inbound(onMessage),
      },
      wrap: async (bytes) => {
        const sealed = await sealForSegment(name, bytes)
        sealedOn.set(sealed.payload, sealed.topicID)
        return sealed.payload
      },
      unwrap: (payload) => openedFrames.get(payload) ?? payload,
    })
  }

  const buildEpoch = async (): Promise<void> => {
    const next = new Map<string, ProtocolRuntime>()
    // ONE inbox lane for the whole peer, not one per protocol: the topic does not name a
    // protocol, so every acceptor and directed client opening its own frames is the defect this
    // shape prevents.
    const selfInbox = inboxTopic(anchor().secret, anchor().epoch, localDID)
    inboxLane = {
      topicID: selfInbox,
      path: createInboxPath({
        mux,
        topicID: selfInbox,
        unwrap: (b) =>
          crypto.unwrap(b, {
            expectedAAD: encodeAppAAD({ topicID: selfInbox, intent: 'ephemeral' }),
          }),
        retainOnFailure,
      }),
    }
    // ONE responder for the whole peer, on the shared path: it NACKs any frame whose tag names a
    // protocol not in `protocols`, restoring the legible reply an acceptor's own filter drops.
    unroutedTagResponder = createUnroutedTagResponder({
      mux,
      localDID,
      inbound: inboxLane.path,
      isRegistered: (name) => Object.hasOwn(protocols, name),
      sealReply: sealDirectedReply,
    })
    for (const [name, protocol] of Object.entries(protocols)) {
      // The app topic is bound to the ANCHOR, not the live epoch — see {@link sealForSegment}.
      // Content stays sealed under the live epoch crypto below; only the topic ID is anchor-bound.
      const topicID = protocolTopic(anchor().secret, anchor().epoch, name)
      // Subscribed for the member's whole life, like the commit and rendezvous topics: the mux
      // never unsubscribes on rotation, only tears down the LISTENERS on the epoch left.
      // Unsubscribing would tell the hub to drop this member's pending deliveries and free any
      // frame it was the last reader of — deleting unread messages for everyone.
      //
      // Subscribed HERE, not left to the transports below, because the subscription is also what
      // asks the hub how long to hold the log; a bus is a fan-out abstraction with no such request.
      mux.retainTopic(topicID, { retention: appLogRetentionSeconds })
      // One path, two consumers: the frame is opened once here and both are given the plaintext.
      const inbound = createInboundPath(name, topicID)
      const client = new BroadcastClient({
        transport: segmentBoundTransport(name, topicID, inbound),
        ...(params.runtime != null ? { runtime: params.runtime } : {}),
      })
      const { events, requestHandlers } = adaptBusHandlers(
        protocol,
        handlers[name] as Record<string, unknown>,
        suppress,
      )
      const busServer = createBroadcastResponder({
        transport: segmentBoundTransport(name, topicID, inbound),
        from: localDID,
        requestHandlers,
        events,
      })
      const acceptor = createInboxAcceptor<ProtocolDefinition>({
        mux,
        localDID,
        selfInboxTopic: selfInbox,
        inbound: inboxLane.path,
        resolveSendTopic: (senderDID) => inboxTopic(anchor().secret, anchor().epoch, senderDID),
        protocol: protocol as ProtocolDefinition,
        protocolName: name,
        handlers: handlers[name] as unknown as ProcedureHandlers<ProtocolDefinition>,
        wrap: crypto.wrap,
      })
      next.set(name, { client, busServer, acceptor, directed: new Map() })
    }
    runtimes = next
  }

  const teardownEpoch = async (): Promise<void> => {
    // Disposal order is independent, so tear everything down concurrently and surface every
    // failure rather than dying on the first.
    const disposals: Array<Promise<unknown>> = []
    // A bare unsubscribe of the shared path — synchronous, cannot reject — dropped alongside the
    // acceptor consumers of that same path.
    unroutedTagResponder?.dispose()
    unroutedTagResponder = undefined
    for (const runtime of runtimes.values()) {
      for (const directed of runtime.directed.values()) disposals.push(directed.dispose())
      runtime.directed.clear()
      disposals.push(runtime.busServer.dispose())
      disposals.push(runtime.acceptor.dispose())
      disposals.push(runtime.client.dispose())
    }
    runtimes = new Map()
    const results = await Promise.allSettled(disposals)
    const reasons = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    // Defensive: no child rejects today — all are enkaku `Disposer`-based (a failing dispose is
    // swallowed to `console.warn`, the promise still resolves) or a refcount decrement that cannot
    // throw — so this guards a future non-`Disposer` child. Kept live because rotation shares this
    // path, and a `BroadcastClient.prototype.dispose` spy forces it in test.
    if (reasons.length > 0) {
      throw new AggregateError(reasons, 'Group epoch teardown failed')
    }
  }

  /** Wait while an advance can move the handle before its new anchor is captured. */
  const sealForSegment = async (
    name: string,
    bytes: Uint8Array,
    intent: 'ephemeral' | 'log' = 'ephemeral',
  ): Promise<SegmentFrame> => {
    while (true) {
      const refused = sealError()
      if (refused != null) throw refused
      const barrier = sealBarrier()
      if (barrier != null) {
        await barrier
        continue
      }
      const at = anchor()
      const topicID = protocolTopic(at.secret, at.epoch, name)
      const payload = await crypto.wrap(bytes, { aad: encodeAppAAD({ topicID, intent }) })
      const refusedAfter = sealError()
      if (refusedAfter != null) throw refusedAfter
      if (anchor() === at && sealBarrier() == null) {
        assertFrameFits(payload)
        return { topicID, payload }
      }
    }
  }

  /**
   * Seal a directed reply (the unrouted-tag NACK) to a recipient's inbox under ONE anchor snapshot.
   * The reply topic and the seal must agree on the epoch: were the topic read from the live anchor
   * and the seal taken as a separate step, a rotation landing between them would address an
   * old-epoch inbox with new-epoch ciphertext, published onto a topic the recipient no longer reads
   * and silently lost. Re-read the anchor after the seal and re-seal if it moved — same identity
   * (not epoch-equality) guard as {@link sealForSegment}.
   */
  const sealDirectedReply = async (
    recipientDID: string,
    tagged: Uint8Array,
  ): Promise<SegmentFrame> => {
    while (true) {
      const at = anchor()
      const topicID = inboxTopic(at.secret, at.epoch, recipientDID)
      const payload = await crypto.wrap(tagged, {
        aad: encodeAppAAD({ topicID, intent: 'ephemeral' }),
      })
      if (anchor() === at) return { topicID, payload }
    }
  }

  const surfaceFor = (name: string): InternalSurface => {
    const runtime = runtimes.get(name)
    if (runtime == null) throw new Error(`Unknown protocol: ${name}`)
    return {
      dispatch: async (prc, config) => {
        const data = config?.data ?? {}
        // Route by the procedure's declared retention. A `log` event goes to the app topic's log
        // lane (retained, pullable); ephemeral events and RPC stay on the live mailbox lane. The
        // log payload is byte-identical to what the broadcast transport would produce, so online
        // subscribers still receive it through the same drain.
        const protocol = protocols[name]
        if (protocol === undefined) throw new Error(`Unknown protocol: ${name}`)
        if (retentionOf(protocol, prc) === 'log') {
          const { topicID, payload } = await sealForSegment(
            name,
            encodeEventFrame(prc, data),
            'log',
          )
          await mux.publish({ topicID, payload, retain: 'log' })
          return
        }
        await runtime.client.dispatch(prc, data)
      },
      request: (prc, config) =>
        runtime.client.request(prc, config?.param, {
          errorThreshold: config?.errorThreshold,
          timeoutMs: config?.timeoutMs,
        }),
      gather: (prc, config) =>
        runtime.client.gather(prc, config?.param, {
          quorum: config?.quorum,
          timeoutMs: config?.timeoutMs,
          onReply: config == null ? undefined : wrapGatherOptions(boundary, config).onReply,
          signal: config?.signal,
        }),
      to: async (memberDID) => {
        // Normalized ONCE, at the ingress: the cache key, the topic derivation and the
        // directed client's own filter (`senderDID !== memberDID`) must all see one canonical
        // form, or a long-form caller never converges onto the short form MLS actually replies
        // under.
        const member = normalizeDID(memberDID)
        const cached = runtime.directed.get(member)
        if (cached != null) return cached.client
        const lane = inboxLane
        if (lane == null) throw new Error('Peer is not started')
        const created = createDirectedClient<ProtocolDefinition>({
          mux,
          localDID,
          memberDID: member,
          sendTopicID: inboxTopic(anchor().secret, anchor().epoch, member),
          // The epoch's own inbox topic and its one open path: reading replies through a path
          // built for a topic this client does not receive on would spend keys opening frames for
          // a lane nobody listens to.
          receiveTopicID: lane.topicID,
          inbound: lane.path,
          wrap: crypto.wrap,
          protocol: name,
          ...(params.runtime != null ? { runtime: params.runtime } : {}),
        })
        runtime.directed.set(member, created)
        return created.client
      },
    }
  }

  const rebuildEpoch = async (): Promise<void> => {
    if (isDisposed()) return
    // Teardown empties the runtimes before it reports a failed child, and a later walk sees the
    // advance as history. Build anyway, then report the failure.
    let failure: { error: unknown } | undefined
    try {
      await teardownEpoch()
    } catch (error) {
      failure = { error }
    }
    if (isDisposed()) return
    await buildEpoch()
    if (failure != null) throw failure.error
  }

  return {
    buildEpoch,
    teardownEpoch,
    rebuildEpoch,
    surfaceFor,
    sealForSegment,
    hasInboxLane: () => inboxLane != null,
    releaseInboxLane: () => {
      inboxLane = undefined
    },
  }
}
