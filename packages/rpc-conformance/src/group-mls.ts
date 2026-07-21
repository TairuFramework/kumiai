/**
 * Conformance suite for the `GroupMLS` consumer port of `@kumiai/rpc`.
 *
 * `GroupMLS` is the lifecycle half of the seam `GroupCrypto` opens: it reads a Commit's own claims
 * before the peer touches it, applies the ones this member is in a position to apply, and reports
 * the roster the apply left behind. Every clause below is a place a double answered where the real
 * port refuses — a header that named a committer the real port cannot authenticate, a commit
 * modelled as a value to adopt when ts-mls advances the handle in place — and each of those
 * shapes, carried across to a host, is silent data loss or a peer that reports itself reconciled
 * at a dead epoch.
 *
 * The port shape is re-declared STRUCTURALLY, for the reason given in `./group-crypto.js`.
 *
 * @module rpc-conformance/group-mls
 */
import { describe, expect, test } from 'vitest'

/** The `CommitHeader` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceCommitHeader = {
  epoch: number
  committerDID?: string
  external?: boolean
}

/** The `CommitContext` of `@kumiai/rpc`, re-declared structurally. */
export type ConformanceCommitContext = {
  senderDID?: string
  resolveLedgerEntries?: (ids: Array<string>) => Promise<Array<string>>
}

/** The `PendingRecovery` of `@kumiai/rpc`, re-declared structurally. */
export type ConformancePendingRecovery = {
  commit: Uint8Array
  onAccepted: () => Promise<void>
}

/**
 * The `GroupMLS` this suite exercises — ALL of it.
 *
 * An earlier version left the recovery and ledger half out, on the reasoning that it is "a
 * multi-party rendezvous whose harness would be most of a peer". That was wrong, and the omission
 * was invisible: eight of twelve port members had no contract, on the two lanes that carry a
 * group's whole authority state. The rendezvous is a lane concern; the PORT is three calls
 * passing bytes between two instances, which is all the clauses below do.
 */
export type ConformanceGroupMLS = {
  rosterDIDs: () => Promise<Array<string>>
  readCommitHeader: (commit: Uint8Array) => Promise<ConformanceCommitHeader | null>
  processCommit: (
    commit: Uint8Array,
    context: ConformanceCommitContext,
  ) => Promise<{ advanced: boolean }>
  exportRecoverySecret: () => Uint8Array | Promise<Uint8Array>
  createRecoveryRequest: (requestID: string) => Promise<Uint8Array>
  sealGroupInfo: (request: Uint8Array) => Promise<Uint8Array>
  applyRecovery: (
    sealed: Uint8Array,
    requestID: string,
  ) => Promise<ConformancePendingRecovery | null>
  isLedgerComplete: () => Promise<boolean>
  getLedger: () => Promise<Array<string>>
  sealLedger: (request: Uint8Array) => Promise<Uint8Array>
  openSealedLedger: (sealed: Uint8Array, requestID: string) => Promise<Array<string> | null>
  bootstrapLedger: (tokens: Array<string>) => Promise<void>
}

export type ConformanceMLSMember = {
  did: string
  mls: ConformanceGroupMLS
}

/** A Commit and the context the lane would deliver alongside it. */
export type ConformanceCommit = {
  commit: Uint8Array
  context: ConformanceCommitContext
}

export type ConformanceMLSGroup = {
  /**
   * The ports under test. The COMMITTER is not among them: every Commit here is authored by a
   * member outside this list, so `processCommit` is only ever asked about a RECEIVED commit —
   * which is the case the port's contract is about, and the case the memory double got wrong.
   */
  members: Array<ConformanceMLSMember>
  /** The DID of the member that authors the commits, for the committer clauses. */
  committerDID: string
  /**
   * Build a Commit framed at the group's CURRENT epoch, and advance the AUTHOR past it — as a
   * real committer does when the hub accepts, and as nothing else may. `members` are untouched:
   * a member reaches the new epoch by being handed these bytes and not otherwise.
   *
   * `removes` names the index in `members` whose leaf the Commit drops.
   */
  buildCommit: (options?: { removes?: number }) => Promise<ConformanceCommit>
  /**
   * A genuine EXTERNAL commit — a rejoin — framed at the group's current epoch, together with a
   * forgery of it: the same frame with only the claimed author rewritten, which is what a
   * publisher holding no key can produce from a frame it observed.
   *
   * Optional: an implementation with no way to build one says so by omitting it, and the two
   * external clauses are skipped rather than faked.
   */
  buildExternalCommit?: (params: {
    /** The index in `members` that is rejoining. */
    rejoining: number
    /** The DID the forgery claims authored it. */
    forgeAs: string
  }) => Promise<{ genuine: Uint8Array; forged: Uint8Array }>
  dispose?: () => void | Promise<void>
}

export type GroupMLSConformanceParams = {
  /** Prefix for the describe block, so a failure names the implementation it came from. */
  label: string
  /** A fresh group of `size` ports plus an outside committer. `id` is unique per case. */
  createGroup: (size: number, id: string) => Promise<ConformanceMLSGroup>
}

/** The member at `index`, with the assertion the suite would otherwise repeat everywhere. */
function memberAt(members: Array<ConformanceMLSMember>, index: number): ConformanceMLSMember {
  const member = members[index]
  if (member == null) throw new Error(`the harness returned no member at index ${index}`)
  return member
}

const NOT_A_COMMIT: Array<Uint8Array> = [
  new Uint8Array(),
  new Uint8Array([0]),
  new Uint8Array([1, 2, 3, 4, 5]),
  new Uint8Array(64).fill(0xff),
  new TextEncoder().encode('{"not":"a commit"}'),
]

export function testGroupMLSConformance(params: GroupMLSConformanceParams): void {
  const { label, createGroup } = params

  const withGroup = async (
    size: number,
    id: string,
    run: (group: ConformanceMLSGroup) => Promise<void>,
  ): Promise<void> => {
    const group = await createGroup(size, id)
    try {
      await run(group)
    } finally {
      await group.dispose?.()
    }
  }

  describe(`GroupMLS conformance — ${label}`, () => {
    describe('readCommitHeader', () => {
      /**
       * The two facts have different trust AND different availability, and conflating them is the
       * defect this contract exists to forbid. The epoch is cleartext and always there; the
       * committer needs the epoch's own secret and is therefore available only at the reader's own
       * epoch — in BOTH directions, since the secret for a ratcheted-past epoch is as gone as one
       * never reached.
       */
      test('returns the epoch for a commit framed at ANY epoch, and the committer only at this member own', async () => {
        await withGroup(2, 'header-availability', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const first = await group.buildCommit()
          const atOwnEpoch = await alice.mls.readCommitHeader(first.commit)
          expect(atOwnEpoch).not.toBeNull()
          const firstEpoch = atOwnEpoch?.epoch as number
          expect(typeof firstEpoch).toBe('number')
          // At the reader's own epoch the commit authenticates its author.
          expect(atOwnEpoch?.committerDID).toBe(group.committerDID)

          // Alice applies it and is now one epoch ON from where that commit was framed.
          expect(await alice.mls.processCommit(first.commit, first.context)).toEqual({
            advanced: true,
          })

          // BELOW: the same bytes, read from the epoch after. Epoch still there — that is what
          // lets a walker classify a frame it has passed — and the committer gone.
          const fromAbove = await alice.mls.readCommitHeader(first.commit)
          expect(fromAbove).not.toBeNull()
          expect(fromAbove?.epoch).toBe(firstEpoch)
          expect(fromAbove?.committerDID).toBeUndefined()

          // ABOVE: a commit framed at an epoch this reader has not reached. Bob never applied the
          // first one. This is the frame a peer that fell behind MUST be able to read: a port that
          // answered `null` here would have it file the group's whole future as poison.
          const second = await group.buildCommit()
          const fromBelow = await bob.mls.readCommitHeader(second.commit)
          expect(fromBelow).not.toBeNull()
          expect(fromBelow?.epoch).toBe(firstEpoch + 1)
          expect(fromBelow?.committerDID).toBeUndefined()
        })
      })

      /**
       * `null` means ONE thing: these bytes are not a Commit at all. The lane files `null` as
       * poison and steps over it, so a port that returned it for a commit it merely could not read
       * would make a peer that fell behind walk to the end of the log and report itself fully
       * reconciled at a dead epoch. That is the failure this clause is here to make impossible.
       */
      test('returns null ONLY for bytes that are not a commit', async () => {
        await withGroup(1, 'header-null', async (group) => {
          const alice = memberAt(group.members, 0)
          for (const bytes of NOT_A_COMMIT) {
            expect(await alice.mls.readCommitHeader(bytes)).toBeNull()
          }
        })
      })
    })

    describe('processCommit', () => {
      /**
       * **The double's shape, and why it is wrong.** ts-mls's `processMessage` replaces the
       * handle's own state, so a RECEIVED commit has nothing to adopt — the port advances in
       * place, and the peer reads the new epoch off the same object it handed the bytes to. A
       * double that modelled every commit as a value adopted separately (true only for a commit
       * this member AUTHORED) would have a host double-apply every received one.
       */
      test('advances IN PLACE for a received commit: the roster the same object reports has moved', async () => {
        await withGroup(3, 'apply-in-place', async (group) => {
          const alice = memberAt(group.members, 0)
          const carol = memberAt(group.members, 2)
          expect(await alice.mls.rosterDIDs()).toContain(carol.did)

          const removal = await group.buildCommit({ removes: 2 })
          expect(await alice.mls.processCommit(removal.commit, removal.context)).toEqual({
            advanced: true,
          })
          // Nothing was adopted, and the roster moved anyway.
          expect(await alice.mls.rosterDIDs()).not.toContain(carol.did)
        })
      })

      /**
       * A Commit that removes the local member is one it can never apply: the commit's path
       * excludes the leaf it drops, so the removed member is handed nothing to derive the new
       * epoch from. Its handle stops there — which is what cutting a member off MEANS — and it is
       * `{ advanced: false }` rather than a throw, because the frame is well formed and there is
       * nothing to retry.
       */
      test('a commit removing the LOCAL member does not advance it, and does not throw', async () => {
        await withGroup(3, 'apply-self-removal', async (group) => {
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const removal = await group.buildCommit({ removes: 2 })
          expect(await carol.mls.processCommit(removal.commit, removal.context)).toEqual({
            advanced: false,
          })

          // ITS OWN LEAF IS GONE, AND THE EPOCH DID NOT MOVE. This was the one clause the two
          // implementations disagreed about, and the double was the wrong one: it left the tree
          // alone on the reasoning that "a member that cannot apply the commit does not learn its
          // roster from it". ts-mls does learn it — `processMessage` applies the proposals to the
          // tree and returns without throwing — so the removed member reports a roster short by
          // one at an epoch that did not move.
          //
          // That combination exists nowhere else, and undiscriminated it reads as a rotation, so
          // it is a clause and not a footnote: `peer.ts` gates its roster diff on the handle
          // having actually ratcheted precisely because of it.
          expect(await carol.mls.rosterDIDs()).not.toContain(carol.did)

          // And the commit is perfectly applicable by everyone else, so what refused it was the
          // removal and not the bytes.
          expect(await bob.mls.processCommit(removal.commit, removal.context)).toEqual({
            advanced: true,
          })
        })
      })

      /**
       * A frame it cannot apply is `{ advanced: false }`, NEVER a throw: a throw leaves the lane's
       * cursor put and re-reads the frame, so a port that threw on a commit it was never in a
       * position to apply would wedge the lane on that frame forever — a late joiner would wedge
       * on its own add-commit, the first frame it reads.
       */
      test('a commit framed at another epoch is { advanced: false } and never a throw, in both directions', async () => {
        await withGroup(2, 'apply-other-epoch', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const first = await group.buildCommit()
          expect(await alice.mls.processCommit(first.commit, first.context)).toEqual({
            advanced: true,
          })
          // BELOW: alice is past it now. Re-reading the frame she has already applied.
          expect(await alice.mls.processCommit(first.commit, first.context)).toEqual({
            advanced: false,
          })

          // ABOVE: bob never applied the first, so the second is framed an epoch ahead of him.
          const second = await group.buildCommit()
          expect(await bob.mls.processCommit(second.commit, second.context)).toEqual({
            advanced: false,
          })
          // Bob is exactly where he was: a refusal advances nothing.
          expect(await bob.mls.processCommit(first.commit, first.context)).toEqual({
            advanced: true,
          })
        })
      })

      test('bytes that are not a commit are { advanced: false } and never a throw', async () => {
        await withGroup(1, 'apply-garbage', async (group) => {
          const alice = memberAt(group.members, 0)
          for (const bytes of NOT_A_COMMIT) {
            expect(await alice.mls.processCommit(bytes, {})).toEqual({ advanced: false })
          }
        })
      })
    })

    describe('rosterDIDs', () => {
      /**
       * It answers for membership and for nothing else, and it must reflect an APPLIED roster
       * change and only an applied one. The lane reads it around `processCommit` to tell a commit
       * that dropped a leaf from one that did not, and rotates the app-lane anchor on the
       * difference — so a port whose roster moved on a commit it refused would rotate a peer onto
       * a topic no one else is on.
       */
      test('reflects an APPLIED roster change, and only an applied one', async () => {
        await withGroup(3, 'roster-applied', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const before = await alice.mls.rosterDIDs()
          expect(before).toContain(carol.did)
          expect(new Set(await bob.mls.rosterDIDs())).toEqual(new Set(before))

          const removal = await group.buildCommit({ removes: 2 })
          // Merely BUILDING it changes nobody's roster: the group moves when a member applies.
          expect(new Set(await alice.mls.rosterDIDs())).toEqual(new Set(before))

          await alice.mls.processCommit(removal.commit, removal.context)
          expect(await alice.mls.rosterDIDs()).not.toContain(carol.did)
          // Bob was handed nothing, so his roster is untouched — the lane must be able to tell
          // "this member applied a remove" from "a remove happened somewhere".
          expect(new Set(await bob.mls.rosterDIDs())).toEqual(new Set(before))
        })
      })
    })

    describe('exportRecoverySecret', () => {
      /**
       * EPOCH-INDEPENDENT and agreed, because it names the non-rotating rendezvous a peer stranded
       * at any epoch has to be able to reach. This is the one place the port deliberately does NOT
       * rotate, and an implementation that keyed it off the epoch would leave exactly the peers
       * that need a heal unable to name the topic they heal on.
       */
      test('is stable across an epoch change and agreed between members', async () => {
        await withGroup(3, 'recovery-secret', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const before = await alice.mls.exportRecoverySecret()
          expect(before.length).toBeGreaterThan(0)
          expect(await bob.mls.exportRecoverySecret()).toEqual(before)

          const removal = await group.buildCommit({ removes: 2 })
          await alice.mls.processCommit(removal.commit, removal.context)
          await bob.mls.processCommit(removal.commit, removal.context)

          expect(await alice.mls.exportRecoverySecret()).toEqual(before)
          expect(await bob.mls.exportRecoverySecret()).toEqual(before)
        })
      })
    })

    describe('external commits', () => {
      /**
       * `external` is STRUCTURAL and the committer is not. An external commit carries its author's
       * DID in its own UpdatePath leaf — which is what makes it readable without the epoch secret
       * — but that leaf's credential is a plain field, and only the commit's own signature binds
       * it to an author. A port that reported an external committer it had not checked would let
       * anything that can publish choose who a frame is from, and the app lane rotates its anchor
       * on exactly this flag.
       */
      test('report the rejoiner ONLY when the signature verifies, and the flag either way', async ({
        skip,
      }) => {
        await withGroup(2, 'external-forgery', async (group) => {
          if (group.buildExternalCommit == null) {
            skip('the harness cannot build an external commit for this implementation')
            return
          }
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const { genuine, forged } = await group.buildExternalCommit({
            rejoining: 1,
            forgeAs: alice.did,
          })

          const real = await alice.mls.readCommitHeader(genuine)
          expect(real?.external).toBe(true)
          expect(real?.committerDID).toBe(bob.did)

          // The forgery names its READER as its own author — the one claim a reader acts on by
          // healing. It is still a commit and still recognizably external: both are cleartext.
          const fake = await alice.mls.readCommitHeader(forged)
          expect(fake).not.toBeNull()
          expect(fake?.external).toBe(true)
          expect(fake?.epoch).toBe(real?.epoch)
          // And the committer is what a forger does not get to choose.
          expect(fake?.committerDID).toBeUndefined()
        })
      })
    })

    /**
     * THE RECOVERY LANE. A stranded peer asks the group for current state on a topic derived from
     * a secret the whole group shares for life, so anyone who ever held it — including a member
     * the group removed — can mint a well-formed request and put it there. What keeps that from
     * being a way back in is the RESPONDER, and only the responder.
     */
    describe('the recovery round trip', () => {
      test('a member answers another member, and the reply rebuilds a rejoin', async () => {
        await withGroup(2, 'recovery-round-trip', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const request = await bob.mls.createRecoveryRequest('req-1')
          const sealed = await alice.mls.sealGroupInfo(request)
          const pending = await bob.mls.applyRecovery(sealed, 'req-1')

          // Narrowed rather than optional-chained: `expect` does not narrow, and a chain that
          // short-circuits would TypeError on `.length` instead of failing this assertion.
          if (pending == null) throw new Error('applyRecovery returned no pending commit')
          expect(pending.commit).toBeInstanceOf(Uint8Array)
          expect(pending.commit.length).toBeGreaterThan(0)
        })
      })

      /**
       * AUTHORIZATION IS ROSTER-INTRINSIC, not a check a caller can forget. A removed member keeps
       * the rendezvous secret for life — it is epoch-independent by design, so a stranded peer on
       * any epoch can always reach the group — so the request it mints is indistinguishable from
       * an honest one. The only thing standing between it and the group's current GroupInfo is
       * that no responder holding its removal will answer.
       *
       * A double that answered anyway would make eviction cosmetic, and nothing else in the stack
       * would notice: the lane's job is to deliver the request, not to judge it.
       */
      test('a responder that has applied a removal refuses the removed member', async () => {
        await withGroup(2, 'recovery-refuses-removed', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          // Bob is removed. Alice applies it; Bob cannot, so he still holds a live handle and the
          // rendezvous secret — exactly the position an evicted member is in.
          const removal = await group.buildCommit({ removes: 1 })
          expect(await alice.mls.processCommit(removal.commit, removal.context)).toEqual({
            advanced: true,
          })
          expect(await alice.mls.rosterDIDs()).not.toContain(bob.did)

          const request = await bob.mls.createRecoveryRequest('req-removed')
          await expect(alice.mls.sealGroupInfo(request)).rejects.toThrow()
        })
      })

      test('a reply minted for another request does not open', async () => {
        await withGroup(2, 'recovery-wrong-request', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const request = await bob.mls.createRecoveryRequest('req-a')
          const sealed = await alice.mls.sealGroupInfo(request)

          // The same bytes, opened against a different request's key. `null` or a throw — the lane
          // reads both the same way — but never a PendingRecovery.
          await expect(bob.mls.applyRecovery(sealed, 'req-b').catch(() => null)).resolves.toBeNull()
        })
      })

      /**
       * The rendezvous topic must be reachable by a peer at ANY epoch, including one that has
       * fallen far behind — that is the whole point of a lane for peers that cannot follow the
       * group. A secret that moved with the epoch would strand exactly the peers it exists for.
       */
      test('the recovery secret does not move with the epoch', async () => {
        await withGroup(2, 'recovery-secret-stable', async (group) => {
          const alice = memberAt(group.members, 0)
          const before = await alice.mls.exportRecoverySecret()
          const commit = await group.buildCommit()
          await alice.mls.processCommit(commit.commit, commit.context)
          expect(await alice.mls.exportRecoverySecret()).toEqual(before)
        })
      })
    })

    /**
     * THE LEDGER GATHER. The ledger is the group's whole authority state — who is an admin, and so
     * who may add, remove, promote and demote. It travels on the same public secretless topic, so
     * every clause here is about a responder refusing, or a requester refusing to believe.
     */
    describe('the ledger gather', () => {
      test('a member seals its whole ordered ledger to another member, who opens it', async () => {
        await withGroup(2, 'ledger-round-trip', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const request = await bob.mls.createRecoveryRequest('gather-1')
          const sealed = await alice.mls.sealLedger(request)
          const opened = await bob.mls.openSealedLedger(sealed, 'gather-1')

          expect(opened).toEqual(await alice.mls.getLedger())
        })
      })

      /**
       * Same roster-intrinsic authorization as `sealGroupInfo`, and it matters more here: this
       * reply is the group's entire authority state, sealed to whatever key the requester put in
       * its own request. A responder that sealed without checking would hand every role and
       * promotion to any stranger who minted one.
       */
      test('a responder that has applied a removal refuses to seal its ledger', async () => {
        await withGroup(2, 'ledger-refuses-removed', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const removal = await group.buildCommit({ removes: 1 })
          await alice.mls.processCommit(removal.commit, removal.context)

          const request = await bob.mls.createRecoveryRequest('gather-removed')
          await expect(alice.mls.sealLedger(request)).rejects.toThrow()
        })
      })

      /**
       * THE KEY IS NOT CONSUMED, and the lane depends on it: every responder answers one gather,
       * so the requester opens reply after reply until one folds to its authenticated head. A port
       * that spent the key on the first open would leave a peer able to consider exactly one
       * responder — and the first reply may be the forged one.
       */
      test('opening one reply does not prevent opening the next', async () => {
        await withGroup(3, 'ledger-two-replies', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)
          const carol = memberAt(group.members, 2)

          const request = await carol.mls.createRecoveryRequest('gather-many')
          const fromAlice = await alice.mls.sealLedger(request)
          const fromBob = await bob.mls.sealLedger(request)

          expect(await carol.mls.openSealedLedger(fromAlice, 'gather-many')).not.toBeNull()
          expect(await carol.mls.openSealedLedger(fromBob, 'gather-many')).not.toBeNull()
        })
      })

      test('a reply sealed for another request does not open', async () => {
        await withGroup(2, 'ledger-wrong-request', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const request = await bob.mls.createRecoveryRequest('gather-a')
          const sealed = await alice.mls.sealLedger(request)
          await expect(
            bob.mls.openSealedLedger(sealed, 'gather-b').catch(() => null),
          ).resolves.toBeNull()
        })
      })

      /**
       * OPENING PROVES NOTHING ABOUT WHO SEALED IT — the gather reply carries no attestation, and
       * an observer of the request can forge one that decrypts. The bound is `bootstrapLedger`'s
       * head check: a list reproducing the head this handle's OWN GroupContext attests to is the
       * group's whole ledger in order, and anything else is refused. A lying responder can
       * withhold; it can never rewrite.
       */
      test('bootstrapLedger refuses a ledger that does not fold to the head this handle attests to', async () => {
        await withGroup(2, 'ledger-head-check', async (group) => {
          const alice = memberAt(group.members, 0)
          const bob = memberAt(group.members, 1)

          const honest = await alice.mls.getLedger()
          if (honest.length === 0) {
            // Nothing to doctor: this implementation's groups carry no ledger entries, so the
            // clause has no subject. Stated rather than silently passing.
            expect(await bob.mls.getLedger()).toEqual([])
            return
          }

          // Genuinely signed tokens, one dropped. No forgery is required, which is the point.
          await expect(bob.mls.bootstrapLedger(honest.slice(0, -1))).rejects.toThrow()

          // And the honest list is accepted, so what refused above was the omission.
          await expect(bob.mls.bootstrapLedger(honest)).resolves.toBeUndefined()
          expect(await bob.mls.getLedger()).toEqual(honest)
        })
      })

      /**
       * `isLedgerComplete` is how a peer knows it must gather before it can be trusted to fold a
       * roster or judge a commit. A port that answered `true` for a handle holding nothing would
       * let a rejoined peer judge commits against an empty authority state.
       */
      test('reports completeness against the head the handle carries', async () => {
        await withGroup(2, 'ledger-complete', async (group) => {
          const alice = memberAt(group.members, 0)
          expect(await alice.mls.isLedgerComplete()).toBe(true)
        })
      })
    })
  })
}
