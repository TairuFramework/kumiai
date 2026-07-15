import type { CommitJournal, JournalEntry } from '../../src/commit.js'

export type MemoryCommitJournal = CommitJournal & {
  /** What the slot holds right now, or null. A restart keeps it: that is the whole point. */
  slot: () => JournalEntry | null
  /** How many pending commits were written. One per commit attempt — a rebase writes again. */
  puts: () => number
  /**
   * How many times `put` overwrote a slot that was still occupied. A single-slot journal is
   * the commit mutex written down: one commit in flight at a time, per group, per device.
   * Anything above zero means two commits were in flight at once and one of them destroyed
   * the other's only record of itself.
   */
  putWhileOccupied: () => number
}

export type MemoryCommitJournalOptions = {
  /** Shared ordering trace, so a test can assert the journal was written BEFORE the publish. */
  trace?: Array<string>
  /** Pre-seed the slot: a process that journalled a commit and died before it landed. */
  slot?: JournalEntry | null
  /**
   * Runs inside `markAccepted`, before the acceptance is recorded. A test throws from here
   * to model the process dying between the hub's answer and the durable write — the one
   * window this record does not close, and the one the store's dedup already covers.
   */
  onMarkAccepted?: () => void
}

/**
 * A host's durable single-slot commit journal, in memory. Surviving a "restart" is just
 * handing the same instance to the new peer — which is exactly what durability buys.
 */
export function createMemoryCommitJournal(
  options: MemoryCommitJournalOptions = {},
): MemoryCommitJournal {
  const trace = options.trace
  let entry: JournalEntry | null = options.slot ?? null
  let puts = 0
  let putWhileOccupied = 0

  return {
    async put(next: JournalEntry) {
      trace?.push(`journal.put:${next.publishID}`)
      puts += 1
      if (entry != null) putWhileOccupied += 1
      entry = next
    },
    async markAccepted(publishID: string, sequenceID: string) {
      options.onMarkAccepted?.()
      // Only ever marks the entry it was given, exactly as `clear` does. It is a second
      // write to the SAME slot, not a new pending commit — so it is no `put`, and the
      // single-slot mutex counters must not see one.
      if (entry?.publishID !== publishID) return
      trace?.push(`journal.markAccepted:${publishID}`)
      entry = { ...entry, acceptedAs: sequenceID }
    },
    async get() {
      return entry
    },
    async clear(publishID: string) {
      // Only ever clears the entry it was given. A clear for an entry the slot no longer
      // holds is a no-op, never a clear of somebody else's pending commit.
      if (entry?.publishID !== publishID) return
      trace?.push(`journal.clear:${publishID}`)
      entry = null
    },
    slot: () => entry,
    puts: () => puts,
    putWhileOccupied: () => putWhileOccupied,
  }
}
