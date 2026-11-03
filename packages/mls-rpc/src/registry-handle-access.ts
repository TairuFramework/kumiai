import { relinquishSend } from '@kumiai/mls'

import type { ControlHandleAccess } from './access.js'
import { registryCapturedReplacements } from './registry/access.js'
import { bindRegistryControlBatch, registryControlBatch } from './registry/control-batch.js'
import type { RegistryHandleAccess } from './registry/types.js'

export function createRegistryHandleAccess(params: {
  access: RegistryHandleAccess
}): ControlHandleAccess {
  const { access } = params
  const result: ControlHandleAccess = {
    epoch: () => access.epoch(),
    admission: () => access.admission(),
    read: (fn) => access.read(fn),
    readControl: (fn) => access.readControl(fn),
    mutate: (fn, adoption) => access.mutate(fn, adoption),
    async replace(next, adoption, prepare) {
      const captured = await relinquishSend(next)
      const replace = registryCapturedReplacements.get(access)
      if (replace === undefined) throw new TypeError('Unknown registry access')
      if (await replace(captured, adoption, prepare)) next.confirmAdopted()
    },
  }
  const batch = registryControlBatch(access)
  if (batch !== undefined) bindRegistryControlBatch(result, batch)
  return result
}
