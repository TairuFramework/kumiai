import type { GroupKey } from './control/types.js'
import { type CoveredFetchResult, checkedFetchResult } from './log-delivery.js'

export type BufferedControlPage = {
  topicID: string
  after: string | null
  generation: number
  result: CoveredFetchResult
}
export type BufferedControlIntake = {
  offer(page: BufferedControlPage): void
  pageCount(): number
  next(): { page: BufferedControlPage; index: number } | undefined
  consumed(input: { generation: number; topicID: string; position: string }): void
  reset(generation: number): void
}

export function createBufferedControlIntake(params: {
  key: GroupKey
  ready(): void
  released?(): void
}): BufferedControlIntake {
  let generation = 0
  const pages: Array<BufferedControlPage> = []
  let index = 0
  const next = () => {
    const page = pages[0]
    return page === undefined ? undefined : { page, index }
  }
  return {
    offer(page) {
      if (page.generation !== generation) return
      checkedFetchResult(page.result)
      if (page.result.messages.length === 0) return
      const available = pages.length === 0
      pages.push(page)
      if (available) params.ready()
    },
    next,
    pageCount: () => pages.length,
    consumed(input) {
      const current = next()
      if (
        current === undefined ||
        input.generation !== generation ||
        input.topicID !== current.page.topicID ||
        input.position !== current.page.result.messages[index]?.sequenceID
      )
        return
      if (++index === current.page.result.messages.length) {
        pages.shift()
        index = 0
        params.released?.()
      }
      if (next() !== undefined) params.ready()
    },
    reset(value) {
      if (value < generation) return
      generation = value
      pages.length = 0
      index = 0
    },
  }
}
