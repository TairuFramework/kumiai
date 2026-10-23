import { createMemoryAppOutbox as createOutbox } from '@kumiai/rpc-conformance'

export function createMemoryAppOutbox(
  params: Parameters<typeof createOutbox>[0] = {
    key: { groupID: crypto.randomUUID(), incarnation: 1 },
    snapshot: () => null,
  },
): ReturnType<typeof createOutbox> {
  return createOutbox(params)
}
