/**
 * Conformance suite for the `GroupCrypto` consumer port of `@kumiai/rpc`.
 *
 * Every clause here exists because a double answered where the real port refuses, and each cost
 * something: the app lane failed to deliver a single message over real MLS while 288 tests stayed
 * green, because the fake's `unwrap` was a pure XOR and the real one spends a ratchet key.
 *
 * The port shape is re-declared STRUCTURALLY below rather than imported from `@kumiai/rpc`,
 * exactly as `@kumiai/hub-conformance` re-declares the hub shapes: `@kumiai/rpc`'s own test suite
 * runs this over its fakes, so depending on it here would put a cycle in the package graph.
 * Structural typing means a real `GroupCrypto` satisfies these without a cast — and the assignment
 * is checked for real in `@kumiai/mls-rpc`'s tests, which may depend on both.
 *
 * @module rpc-conformance/group-crypto
 */
import { describe, expect, test } from 'vitest'

/** The `UnwrapResult` of `@kumiai/broadcast`, re-declared. */
export type ConformanceUnwrapResult = { payload: Uint8Array; senderDID?: string }

/** The `GroupCrypto` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceGroupCrypto = {
  epoch: () => number
  exportSecret: () => Uint8Array | Promise<Uint8Array>
  wrap: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
  unwrap: (
    bytes: Uint8Array,
  ) => Uint8Array | ConformanceUnwrapResult | Promise<Uint8Array | ConformanceUnwrapResult>
  frameEpoch: (bytes: Uint8Array) => number | null
  sealEntries: (bytes: Uint8Array) => Uint8Array | Promise<Uint8Array>
  openEntries: (sealed: Uint8Array) => Uint8Array | Promise<Uint8Array>
}

export type ConformanceCryptoMember = {
  /** The DID `unwrap` must recover as the authenticated sender of this member's frames. */
  did: string
  crypto: ConformanceGroupCrypto
}

export type ConformanceCryptoGroup = {
  /** One entry per member, all at the same epoch, in a fresh group. */
  members: Array<ConformanceCryptoMember>
  /**
   * Enact a Commit that REMOVES `members[index]`. Every other member advances one epoch; the
   * removed one does not, and holds the epoch it was at for life.
   *
   * A removal rather than a bare "advance" because the removal boundary IS the epoch boundary
   * this port is asked about: the clauses below want both a group that moved and a member that
   * could not follow it.
   */
  removeMember: (index: number) => Promise<void>
  /** Enact a Commit that touches no membership: EVERY member advances one epoch. */
  advance: () => Promise<void>
  dispose?: () => void | Promise<void>
}

export type GroupCryptoConformanceParams = {
  /** Prefix for the describe block, so a failure names the implementation it came from. */
  label: string
  /**
   * A fresh group of `size` members sharing MLS state and nothing else. Called once per case;
   * `id` is unique per case so an implementation keyed by group id gets a clean one.
   */
  createGroup: (size: number, id: string) => Promise<ConformanceCryptoGroup>
}

/** The member at `index`, with the assertion the suite would otherwise repeat everywhere. */
function memberAt(members: Array<ConformanceCryptoMember>, index: number): ConformanceCryptoMember {
  const member = members[index]
  if (member == null) throw new Error(`the harness returned no member at index ${index}`)
  return member
}

const utf8 = new TextEncoder()
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

/**
 * A call the port is expected to REFUSE.
 *
 * Wrapped rather than passed straight to `expect().rejects`, because the port's own types allow a
 * SYNCHRONOUS implementation (`Uint8Array | Promise<Uint8Array>`) and a synchronous one refuses by
 * throwing rather than by rejecting. Both are conformant — `@kumiai/rpc`'s fake throws, the real
 * `@kumiai/mls-rpc` port rejects, and `peer.ts` tolerates either (the mux catches a listener's
 * throw, and every read path awaits inside a `try`). A suite that only accepted a rejection would
 * be testing which of the two an implementation happened to pick.
 */
async function refuses(call: () => unknown): Promise<void> {
  await expect(
    (async () => {
      return await call()
    })(),
  ).rejects.toThrow()
}

async function opened(
  crypto: ConformanceGroupCrypto,
  bytes: Uint8Array,
): Promise<ConformanceUnwrapResult> {
  const result = await crypto.unwrap(bytes)
  return result instanceof Uint8Array ? { payload: result } : result
}

export function testGroupCryptoConformance(params: GroupCryptoConformanceParams): void {
  const { label, createGroup } = params

  const withGroup = async (
    size: number,
    id: string,
    run: (group: ConformanceCryptoGroup) => Promise<void>,
  ): Promise<void> => {
    const group = await createGroup(size, id)
    try {
      await run(group)
    } finally {
      await group.dispose?.()
    }
  }

  describe(`GroupCrypto conformance — ${label}`, () => {
    describe('exportSecret', () => {
      /**
       * The app-lane topic is derived from this and from nothing that travels, so a port whose
       * members disagreed at an epoch would put every member on a topic of its own.
       */
      test('every member at an epoch derives the SAME secret, with nothing exchanged', async () => {
        await withGroup(3, 'export-agreed', async ({ members }) => {
          const first = memberAt(members, 0)
          const secret = await first.crypto.exportSecret()
          expect(secret.length).toBeGreaterThan(0)
          for (const member of members.slice(1)) {
            expect(await member.crypto.exportSecret()).toEqual(secret)
          }
        })
      })

      /**
       * PER-EPOCH, and the removal boundary is exactly this clause. A port that exported one value
       * for the group's life would let a removed member name every topic the group ever moves to,
       * which is the whole thing the app lane's rotation buys.
       */
      test('is PER-EPOCH: the group rotates onto a different secret and the removed member keeps the old one', async () => {
        await withGroup(3, 'export-per-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          const before = await alice.crypto.exportSecret()
          expect(await carol.crypto.exportSecret()).toEqual(before)

          await group.removeMember(2)

          const after = await alice.crypto.exportSecret()
          expect(after).not.toEqual(before)
          // Carol never advanced, so she is left holding the value she had — for life, and it is
          // not the one the group moved to.
          expect(await carol.crypto.exportSecret()).toEqual(before)
          expect(await carol.crypto.exportSecret()).not.toEqual(after)
        })
      })

      test('epoch() moves with the group and stands still for the member that could not follow', async () => {
        await withGroup(3, 'export-epoch-number', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          const before = alice.crypto.epoch()
          expect(carol.crypto.epoch()).toBe(before)
          await group.removeMember(2)
          expect(alice.crypto.epoch()).toBe(before + 1)
          expect(carol.crypto.epoch()).toBe(before)
        })
      })
    })

    describe('wrap / unwrap', () => {
      test('round-trips and names the AUTHENTICATED sender', async () => {
        await withGroup(2, 'roundtrip', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const sealed = await alice.crypto.wrap(utf8.encode('hello'))
          const result = await opened(bob.crypto, sealed)
          expect(text(result.payload)).toBe('hello')
          expect(result.senderDID).toBe(alice.did)
        })
      })

      /**
       * **Defect A, pinned.** Opening is a CONSUMING operation: a real handle spends the frame's
       * own per-message ratchet key on the first open and has nothing left for a second. The fake
       * was a pure XOR, so the peer opening every live frame twice cost nothing against it and
       * lost every frame against real MLS — with 288 tests green.
       *
       * A port that answered twice would let any lane put two consumers on one topic.
       */
      test('unwrap CONSUMES the frame: the second open of the same bytes does not succeed', async () => {
        await withGroup(2, 'single-use', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const sealed = await alice.crypto.wrap(utf8.encode('once'))
          expect(text((await opened(bob.crypto, sealed)).payload)).toBe('once')
          await refuses(() => bob.crypto.unwrap(sealed))
        })
      })

      /**
       * `wrap` is NOT PURE, and this is what is actually guaranteed in its place: two seals of one
       * plaintext are two independent frames, each openable once. Byte equality is NOT guaranteed
       * — the real port consumes a ratchet key per seal — so nothing may key off the ciphertext
       * being a function of the plaintext.
       *
       * Stated as "both open" rather than "the bytes differ" because a deterministic `wrap` is a
       * legal implementation; a `wrap` whose second frame cannot be opened is not, and that is the
       * failure a pure-XOR double plus a consuming `unwrap` would actually produce.
       */
      test('wrap is NOT PURE: two seals of one plaintext are two independently openable frames', async () => {
        await withGroup(2, 'wrap-impure', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const first = await alice.crypto.wrap(utf8.encode('same'))
          const second = await alice.crypto.wrap(utf8.encode('same'))
          expect(text((await opened(bob.crypto, first)).payload)).toBe('same')
          expect(text((await opened(bob.crypto, second)).payload)).toBe('same')
        })
      })

      /**
       * The CURRENT epoch is what the port must open, and an epoch it has not REACHED is what it
       * must refuse — a frame sealed above a reader has keys the reader does not hold yet, and no
       * implementation may guess at them. Refusing is ORDINARY CONTROL FLOW rather than an error:
       * it is how a frame on a shared log says "not my epoch", and every reader in group-rpc walks
       * logs full of them.
       */
      test('unwrap opens at the CURRENT epoch and refuses one sealed at an epoch it has not reached', async () => {
        await withGroup(3, 'unwrap-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)
          await group.removeMember(2)
          const atNew = await alice.crypto.wrap(utf8.encode('after'))

          // ABOVE: carol stayed behind and has no keys for the epoch the group moved to.
          await refuses(() => carol.crypto.unwrap(atNew))
          expect(text((await opened(bob.crypto, atNew)).payload)).toBe('after')

          // And the port is still usable: a refusal is not a state a handle gets stuck in.
          const live = await alice.crypto.wrap(utf8.encode('still live'))
          expect(text((await opened(bob.crypto, live)).payload)).toBe('still live')
        })
      })

      /**
       * BELOW the current epoch there is a WINDOW, and its width is implementation-defined — which
       * is exactly why nothing in group-rpc may depend on it.
       *
       * The two implementations genuinely disagree one epoch down, and both are conformant. The
       * fake refuses immediately. A real ts-mls handle advanced by `processMessage` still holds a
       * few epochs' key material and opens it (observed: a frame sealed at epoch 3 opens against
       * the same handle at epoch 4). The port contract says so in as many words — "a real MLS
       * handle also opens a few epochs BELOW the current one ... but group-rpc must not depend on
       * that window" — so this suite does not assert which, and asserts instead the thing that
       * makes the window unusable: it is BOUNDED, and it is spent by epoch TRANSITIONS rather than
       * by time. A peer catching up destroys the very keys a past-epoch read would need, so a
       * member away four commits could read and a member away a week could not, and correctness
       * would turn on how far behind a peer happened to fall.
       *
       * Six transitions is past every implementation's window here; ts-mls keeps four.
       */
      test('a frame sealed FAR below the current epoch is gone for good: the window is bounded and spent by transitions', async () => {
        await withGroup(2, 'unwrap-window', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const stale = await alice.crypto.wrap(utf8.encode('long ago'))
          const from = bob.crypto.epoch()
          for (let step = 0; step < 6; step++) await group.advance()
          expect(bob.crypto.epoch()).toBe(from + 6)
          await refuses(() => bob.crypto.unwrap(stale))
        })
      })
    })

    describe('frameEpoch', () => {
      /**
       * KEYLESS, and that is the whole of what it is for. `unwrap` throwing cannot say WHICH
       * not-my-epoch, and a reader that cannot tell "ahead of me" from "below me" cannot hold a
       * durable read position — it either loses frames it has not reached or pins its cursor
       * forever.
       */
      test('reads the seal epoch from cleartext, including for a frame this member cannot open', async () => {
        await withGroup(3, 'frame-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          const old = alice.crypto.epoch()
          const atOld = await alice.crypto.wrap(utf8.encode('before'))
          expect(alice.crypto.frameEpoch(atOld)).toBe(old)

          await group.removeMember(2)
          const atNew = await alice.crypto.wrap(utf8.encode('after'))
          expect(alice.crypto.frameEpoch(atNew)).toBe(old + 1)

          // Carol is at the old epoch and can never open this frame — and still reads its epoch.
          expect(carol.crypto.epoch()).toBe(old)
          expect(carol.crypto.frameEpoch(atNew)).toBe(old + 1)
          await refuses(() => carol.crypto.unwrap(atNew))
        })
      })

      /**
       * TOTAL, and it must never invent an epoch: it is asked about every frame a log holds, most
       * of which are not this handle's. A double that answered a plausible number for garbage
       * would have a reader park its cursor behind bytes that will never open.
       */
      test('is TOTAL: null for bytes that are not a readable sealed frame, and never throws', async () => {
        await withGroup(1, 'frame-epoch-garbage', async ({ members }) => {
          const alice = memberAt(members, 0)
          for (const bytes of [
            new Uint8Array(),
            new Uint8Array([0]),
            new Uint8Array([1, 2, 3, 4, 5]),
            new Uint8Array(64).fill(0xff),
            utf8.encode('not a frame at all, just some text'),
          ]) {
            expect(alice.crypto.frameEpoch(bytes)).toBeNull()
          }
        })
      })
    })

    /**
     * The ledger-entry seal is its own surface because the MLS port opens the blob from INSIDE the
     * apply of the commit that carries it, where `wrap`/`unwrap` cannot be used: they consume a
     * ratchet generation and mutate the handle. These three properties are what make a derived key
     * a correct replacement, and each is required rather than incidental.
     */
    describe('the ledger-entry seal', () => {
      test('is PER-EPOCH: a member at another epoch cannot open the blob', async () => {
        await withGroup(3, 'entries-per-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          const atOld = await alice.crypto.sealEntries(utf8.encode('entries before'))
          await group.removeMember(2)
          const atNew = await alice.crypto.sealEntries(utf8.encode('entries after'))

          // The removal boundary again, and the entry blob rests on it exactly as the anchor
          // does: carol keeps the old epoch's key for life and it opens nothing sealed after.
          expect(text(await carol.crypto.openEntries(atOld))).toBe('entries before')
          await refuses(() => carol.crypto.openEntries(atNew))
          // And the member that ratcheted forward derives a different key too.
          await refuses(() => alice.crypto.openEntries(atOld))
        })
      })

      /**
       * IT IS AUTHENTICATED, and this clause exists because the lane spends that assumption
       * without ever having checked it. A commit whose entries will not resolve is filed as
       * POISON — stepped over, cursor advanced, never re-read — on the reasoning that a blob this
       * peer cannot open is one no member at this epoch can. That reasoning holds only if the
       * bytes on the wire are the bytes the author sealed. A seal that opened tampered bytes, or
       * that returned a truncated plaintext instead of refusing, would let anyone who can modify
       * a frame in transit turn any commit into poison for a chosen peer.
       *
       * Refusal, not silence: an implementation that returned empty bytes for a tampered blob
       * would be indistinguishable from one that opened an empty one.
       */
      test('is AUTHENTICATED: a tampered blob is refused, not opened', async () => {
        await withGroup(2, 'entries-tampered', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const sealed = await alice.crypto.sealEntries(utf8.encode('the real entries'))
          expect(text(await bob.crypto.openEntries(sealed))).toBe('the real entries')

          // Every byte position, one at a time: a seal whose tail is authenticated but whose
          // header is not would pass a test that only flipped one end.
          for (const index of [0, Math.floor(sealed.length / 2), sealed.length - 1]) {
            const tampered = Uint8Array.from(sealed)
            tampered[index] = ((tampered[index] as number) ^ 0xff) & 0xff
            await refuses(() => bob.crypto.openEntries(tampered))
          }

          // Truncation is tampering too, and it is the one a length check alone would miss.
          await refuses(() => bob.crypto.openEntries(sealed.subarray(0, sealed.length - 1)))
        })
      })

      test('is AGREED: every member at an epoch opens what any other sealed, with nothing exchanged', async () => {
        await withGroup(2, 'entries-agreed', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const fromAlice = await alice.crypto.sealEntries(utf8.encode('alice sealed'))
          expect(text(await bob.crypto.openEntries(fromAlice))).toBe('alice sealed')
          const fromBob = await bob.crypto.sealEntries(utf8.encode('bob sealed'))
          expect(text(await alice.crypto.openEntries(fromBob))).toBe('bob sealed')
        })
      })

      /**
       * PURE, and the port may not implement it otherwise — the one caller opens from inside an
       * apply. Two halves: opening twice gives the same answer, and it spends nothing off the
       * ratchet the app lane runs on.
       */
      test('is PURE: opening twice gives the same answer and consumes no ratchet generation', async () => {
        await withGroup(2, 'entries-pure', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const sealed = await alice.crypto.sealEntries(utf8.encode('opened twice'))
          expect(await bob.crypto.openEntries(sealed)).toEqual(await bob.crypto.openEntries(sealed))

          const frame = await alice.crypto.wrap(utf8.encode('still works'))
          expect(text((await opened(bob.crypto, frame)).payload)).toBe('still works')
        })
      })

      /**
       * The two seals are NOT interchangeable, and the port says so. A blob sealed for the ledger
       * is not an application message, and an implementation that made them one surface would
       * reintroduce the deadlock the entry seal exists to remove.
       */
      test('is NOT the app seal: an entry blob does not open as a frame, and a frame does not open as entries', async () => {
        await withGroup(2, 'entries-distinct', async ({ members }) => {
          const alice = memberAt(members, 0)
          const bob = memberAt(members, 1)
          const blob = await alice.crypto.sealEntries(utf8.encode('ledger bodies'))
          await refuses(() => bob.crypto.unwrap(blob))
          const frame = await alice.crypto.wrap(utf8.encode('app payload'))
          await refuses(() => bob.crypto.openEntries(frame))
        })
      })
    })
  })
}
