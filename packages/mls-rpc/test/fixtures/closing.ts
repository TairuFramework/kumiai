import { retirementDomain } from '../../src/closing-preparation.js'
import { type ClosingDomain, type EntryReads, entryCapability } from '../../src/entry-capability.js'
import type {
  GroupPersistence,
  GroupStores,
  GroupTransaction,
  GroupTransition,
} from '../../src/persistence-types.js'
import { prepareIncarnationRetirement, type RetirementRequest } from '../../src/registry/retired.js'

// Direct storage fixtures declare their domain plan before provider work, like registry producers.
export async function preparedTransition<TTx extends GroupTransaction, TResult>(
  groups: GroupPersistence<TTx>,
  change: GroupTransition,
  domain: ClosingDomain | ((reads: EntryReads) => Promise<ClosingDomain>),
  work: (
    stores: GroupStores<TTx>,
    domain: ClosingDomain & { retirement?: RetirementRequest },
  ) => Promise<TResult>,
  retirement?: RetirementRequest,
): Promise<TResult> {
  const entry = entryCapability(groups)
  if (entry === null) throw new Error('Missing registered preparation capability')
  return entry.run(
    change,
    async (reads, closing) => {
      let plan = typeof domain === 'function' ? await domain(reads) : domain
      const previous = await reads.lifetime()
      const preparedRetirement =
        retirement === undefined ? undefined : await prepareIncarnationRetirement(reads, retirement)
      const prepared = {
        expected: change.expected,
        value: { ...plan, retirement: preparedRetirement },
      }
      if (previous === null) return prepared
      const displaced =
        plan.lifetime !== null && plan.lifetime.activeIncarnation !== previous.activeIncarnation
      let terminal = false
      for (const state of plan.states)
        if (
          !state.deleted &&
          state.terminal &&
          !(await reads.metadata(state.incarnation))?.terminal
        )
          terminal = true
      if (!displaced && !terminal && !plan.states.some((state) => state.deleted)) return prepared
      if (plan.lifetime !== null) plan = await retirementDomain(reads, plan.lifetime, plan.states)
      return closing.freeze({
        source: {
          groupID: change.groupID,
          incarnation: previous.activeIncarnation ?? previous.latestIncarnation,
        },
        reason: displaced
          ? plan.lifetime?.activeIncarnation === null
            ? 'delete'
            : 'readmission'
          : 'terminal',
        prepared: { ...prepared, value: { ...plan, retirement: preparedRetirement } },
        domain: plan,
      })
    },
    work,
  )
}
