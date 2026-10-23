import { createMemoryAppOutbox as createOutbox } from '@kumiai/rpc-conformance'

const bindings = new WeakMap<
  object,
  {
    key: { groupID: string; incarnation: number }
    snapshot: Parameters<typeof createOutbox>[0]['snapshot']
  }
>()

export function bindMemoryOutbox(
  outbox: object,
  snapshot: Parameters<typeof createOutbox>[0]['snapshot'],
  key?: { groupID: string; incarnation: number },
) {
  const binding = bindings.get(outbox) ?? bindings.get(Reflect.get(outbox, 'loadSettlement'))
  if (binding === undefined) return
  if (key !== undefined) Object.assign(binding.key, key)
  binding.snapshot = snapshot
  return binding.key
}

export function createMemoryAppOutbox(
  params: Parameters<typeof createOutbox>[0] = {
    key: { groupID: crypto.randomUUID(), incarnation: 1 },
    snapshot: () => null,
  },
): ReturnType<typeof createOutbox> {
  const binding = { key: { ...params.key }, snapshot: params.snapshot }
  const outbox = createOutbox({ key: binding.key, snapshot: () => binding.snapshot() })
  bindings.set(outbox, binding)
  bindings.set(outbox.loadSettlement, binding)
  return outbox
}
